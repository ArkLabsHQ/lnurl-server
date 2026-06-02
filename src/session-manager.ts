import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import type { Session, SessionEvent } from "./types.js";
import { deriveSessionId } from "./session-id.js";

/** Constant-time comparison for secret tokens (avoids a byte-by-byte timing oracle). */
function tokensEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export class SessionManager {
  private sessions = new Map<string, Session>();

  /** Create a new session and wire up the SSE response.
   *  When `providedToken` is supplied the sessionId is derived from it
   *  deterministically, so reconnecting produces the same LNURL. */
  create(sseRes: Response, providedToken?: string): Session | null {
    const token = providedToken || randomBytes(32).toString("hex");
    const id = providedToken
      ? deriveSessionId(providedToken)
      : randomBytes(16).toString("hex");

    const existing = this.sessions.get(id);
    if (existing) {
      if (!tokensEqual(existing.token, token)) return null;
      this.destroy(id);
    }

    const session: Session = {
      id,
      token,
      createdAt: Date.now(),
      sseRes,
      pendingInvoice: null,
      pendingWithdraw: null,
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

  /** Verify the auth token for a session (constant-time). */
  verifyToken(id: string, token: string): boolean {
    const session = this.sessions.get(id);
    return !!session && tokensEqual(session.token, token);
  }

  /** True iff a session already exists for this token's derived id but with a different
   *  token. Checked before committing the SSE 200 so a collision returns a clean 409
   *  rather than an in-stream error. (A real collision is a SHA-256 break — unreachable.) */
  peekCollision(token: string): boolean {
    const existing = this.sessions.get(deriveSessionId(token));
    return !!existing && !tokensEqual(existing.token, token);
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

  /** Destroy a session and reject any pending invoice or withdraw request */
  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    if (session.pendingInvoice) {
      session.pendingInvoice.reject(new Error("Session closed"));
    }

    if (session.pendingWithdraw) {
      session.pendingWithdraw.reject(new Error("Session closed"));
    }

    this.sessions.delete(id);
  }

  /** All currently-connected session ids. */
  activeSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Relay a withdrawer's bolt11 to the funding wallet via SSE and wait for approval or rejection. */
  requestWithdraw(
    id: string,
    payload: { withdrawId: string; bolt11: string; minWithdrawable: number; maxWithdrawable: number; description?: string },
    timeoutMs: number,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return Promise.reject(new Error("Session not found"));
    if (session.pendingWithdraw) return Promise.reject(new Error("Another withdraw is already pending"));

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingWithdraw = null;
        reject(new Error("Withdraw request timed out"));
      }, timeoutMs);

      session.pendingWithdraw = {
        withdrawId: payload.withdrawId,
        resolve: () => { clearTimeout(timer); session.pendingWithdraw = null; resolve(); },
        reject: (err: Error) => { clearTimeout(timer); session.pendingWithdraw = null; reject(err); },
      };

      this.sendEvent(id, {
        type: "withdraw_request",
        data: {
          withdrawId: payload.withdrawId,
          bolt11: payload.bolt11,
          minWithdrawable: payload.minWithdrawable,
          maxWithdrawable: payload.maxWithdrawable,
          description: payload.description,
        },
      });
    });
  }

  /** Funding wallet approved the withdraw — resolves the pending withdrawer request. */
  resolveWithdraw(id: string, withdrawId: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pendingWithdraw || session.pendingWithdraw.withdrawId !== withdrawId) return false;
    session.pendingWithdraw.resolve();
    return true;
  }

  /** Funding wallet rejected the withdraw — fails the pending withdrawer request with the given reason. */
  rejectWithdraw(id: string, withdrawId: string, reason: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.pendingWithdraw || session.pendingWithdraw.withdrawId !== withdrawId) return false;
    session.pendingWithdraw.reject(new Error(reason));
    return true;
  }
}
