// The enclave's client for the checkpoint authority. Nothing the authority says is used
// until its statement verifies against a pinned key, for this deployment, echoing the
// nonce this request carried.

import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import {
  decodeStatement, encodeActivate, encodeCommit,
  type ActivatePayload, type CommitPayload, type StatementPayload,
} from "./authority-wire.js";

/** A refusal the authority stood behind. `current` is its verified state, when it sent one. */
export class AuthorityRefusal extends Error {
  constructor(readonly code: string, message: string, readonly current?: StatementPayload) {
    super(`authority refused (${code}): ${message}`);
  }
}

/** No trustworthy answer: unreachable, overloaded, or a statement that did not verify. */
export class AuthorityUnavailable extends Error {}

export interface AuthorityClientOptions {
  url: string;
  deployment: string;
  /** SPKI DER. A statement's key id is the SHA-256 of one of these. */
  publicKeys: readonly Uint8Array[];
  timeoutMs?: number;
  maxSkewMs?: number;
  now?: () => number;
}

export interface CheckpointAuthority {
  state(nonce: Uint8Array): Promise<StatementPayload>;
  challenge(): Promise<{ challengeId: string; nonce: Uint8Array; expiresAtMs: number }>;
  activate(m: ActivatePayload, writer: KeyObject, attestationDocument: Uint8Array): Promise<StatementPayload>;
  commit(m: CommitPayload, writer: KeyObject): Promise<StatementPayload>;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

export function createAuthorityClient(o: AuthorityClientOptions): CheckpointAuthority {
  const keys = new Map<string, KeyObject>(
    o.publicKeys.map((spki) => [sha256(spki).toString("hex"), createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" })]),
  );
  const now = o.now ?? Date.now;
  const maxSkewMs = o.maxSkewMs ?? 300_000;

  async function post(path: string, body: object): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await fetch(`${o.url.replace(/\/+$/, "")}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new AuthorityUnavailable(`authority unreachable: ${(error as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  }

  function verified(raw: unknown, nonce: Uint8Array): StatementPayload {
    const st = raw as { payload?: unknown; signature?: unknown } | undefined;
    if (typeof st?.payload !== "string" || typeof st.signature !== "string") throw new AuthorityUnavailable("authority sent no statement");
    const payload = Buffer.from(st.payload, "base64");
    let m: StatementPayload;
    try {
      m = decodeStatement(payload);
    } catch (error) {
      throw new AuthorityUnavailable(`authority statement unreadable: ${(error as Error).message}`);
    }
    const key = keys.get(m.authorityKeyId);
    if (!key) throw new AuthorityUnavailable(`authority statement names key ${m.authorityKeyId}, which is not pinned`);
    if (!verify("sha256", payload, key, Buffer.from(st.signature, "base64"))) throw new AuthorityUnavailable("authority statement signature does not verify");
    if (m.deployment !== o.deployment) throw new AuthorityUnavailable(`authority statement is for ${m.deployment}`);
    if (!Buffer.from(m.callerNonce).equals(Buffer.from(nonce))) throw new AuthorityUnavailable("authority statement answers another request");
    if (Math.abs(now() - m.issuedAtUnixMs) > maxSkewMs) throw new AuthorityUnavailable("authority statement is outside the clock skew allowed");
    return m;
  }

  function fail(r: { status: number; json: Record<string, unknown> }, nonce: Uint8Array): never {
    if (r.status >= 500) throw new AuthorityUnavailable(`authority answered ${r.status}`);
    const current = r.json.statement === undefined ? undefined : verified(r.json.statement, nonce);
    throw new AuthorityRefusal(String(r.json.error ?? `http_${r.status}`), String(r.json.message ?? ""), current);
  }

  function answer(r: { status: number; json: Record<string, unknown> }, nonce: Uint8Array): StatementPayload {
    if (r.status !== 200) fail(r, nonce);
    return verified(r.json.statement, nonce);
  }

  return {
    async state(nonce) {
      return answer(await post("/v1/state", { deployment: o.deployment, nonce: Buffer.from(nonce).toString("hex") }), nonce);
    },
    async challenge() {
      const r = await post("/v1/challenge", { deployment: o.deployment, purpose: "activate" });
      if (r.status !== 200) fail(r, new Uint8Array());
      return { challengeId: String(r.json.challengeId), nonce: Buffer.from(String(r.json.nonce), "hex"), expiresAtMs: Number(r.json.expiresAtUnixMs) };
    },
    async activate(m, writer, attestationDocument) {
      const payload = encodeActivate(m);
      const r = await post("/v1/writer/activate", {
        payload: Buffer.from(payload).toString("base64"),
        attestationDocument: Buffer.from(attestationDocument).toString("base64"),
        proofOfPossession: sign(null, payload, writer).toString("base64"),
      });
      return answer(r, sha256(payload));
    },
    async commit(m, writer) {
      const payload = encodeCommit(m);
      const r = await post("/v1/checkpoint/commit", {
        payload: Buffer.from(payload).toString("base64"), signature: sign(null, payload, writer).toString("base64"),
      });
      return answer(r, sha256(payload));
    },
  };
}
