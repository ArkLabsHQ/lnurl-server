import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { Session, SessionEvent } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, Session>();

  /** Derive a sessionId from a token: first 32 hex chars of SHA-256(token_bytes). */
  private static deriveSessionId(tokenHex: string): string {
    return createHash("sha256")
      .update(Buffer.from(tokenHex, "hex"))
      .digest("hex")
      .slice(0, 32);
  }

  /** Create a new session and wire up the SSE response.
   *  When `providedToken` is supplied the sessionId is derived from it
   *  deterministically, so reconnecting produces the same LNURL. */
  create(sseRes: Response, providedToken?: string): Session | null {
    const token = providedToken || randomBytes(32).toString("hex");
    const id = providedToken
      ? SessionManager.deriveSessionId(providedToken)
      : randomBytes(16).toString("hex");

    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.token !== token) return null;
      this.destroy(id);
    }

    const session: Session = {
      id,
      token,
      createdAt: Date.now(),
      sseRes,
      pendingInvoice: null,
    };

    this.sessions.set(id, session);

    // Clean up on disconnect
    sseRes.on("close", () => {
      this.destroy(id);
    });

    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Check if a session is still active (SSE connected) */
  isActive(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Verify the auth token for a session */
  verifyToken(id: string, token: string): boolean {
    const session = this.sessions.get(id);
    return !!session && session.token === token;
  }

  /** Send an SSE event to the wallet */
  sendEvent(id: string, event: SessionEvent): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    const { sseRes } = session;
    sseRes.write(`event: ${event.type}\n`);
    sseRes.write(`data: ${JSON.stringify(event.data)}\n\n`);
    return true;
  }

  /**
   * Request an invoice from the wallet and wait for it.
   * Returns a promise that resolves with the bolt11 string,
   * or rejects on timeout / session disconnect.
   */
  requestInvoice(
    id: string,
    amountMsat: number,
    comment: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) {
      return Promise.reject(new Error("Session not found"));
    }
    if (session.pendingInvoice) {
      return Promise.reject(
        new Error("Another invoice request is already pending"),
      );
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingInvoice = null;
        reject(new Error("Invoice request timed out"));
      }, timeoutMs);

      session.pendingInvoice = {
        resolve: (pr: string) => {
          clearTimeout(timer);
          session.pendingInvoice = null;
          resolve(pr);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          session.pendingInvoice = null;
          reject(err);
        },
      };

      // Notify wallet via SSE
      this.sendEvent(id, {
        type: "invoice_request",
        data: { amountMsat, comment },
      });
    });
  }

  /** Wallet provides the bolt11 — resolves the pending payer request */
  resolveInvoice(id: string, pr: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pendingInvoice) return false;
    session.pendingInvoice.resolve(pr);
    return true;
  }

  /** Wallet rejects the invoice request — fails the pending payer request */
  rejectInvoice(id: string, reason: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pendingInvoice) return false;
    session.pendingInvoice.reject(new Error(reason));
    return true;
  }

  /** Destroy a session and reject any pending invoice request */
  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.pendingInvoice) {
      session.pendingInvoice.reject(new Error("Session closed"));
    }

    this.sessions.delete(id);
  }
}
