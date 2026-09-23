// The checkpoint authority's signed payloads, byte for byte as `authority/internal/wire`
// encodes them. Signatures cover these bytes and fields are read back out of them; the
// vectors in `authority/testdata/wire-vectors.json` hold both languages to one encoding.

export const TAG_ACTIVATE = "lnurl.enclave.authority.activate.v1";
export const TAG_COMMIT = "lnurl.enclave.authority.commit.v1";
export const TAG_STATEMENT = "lnurl.enclave.authority.statement.v1";

const VERSION = 1;
const SNAPSHOT_SUFFIX = ".sqlite.br.enc";
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** A checkpoint as sealed. `sealEpoch` is the epoch in that object's associated data. */
export interface WireHead {
  schema: string;
  prefix: string;
  schemaVersion: number;
  sealEpoch: number;
  sequence: number;
  previousDigest: string | null;
  digest: string;
  size: number;
  ciphertextDigest: string;
  key: string;
}

export interface ActivatePayload {
  deployment: string;
  challengeId: string;
  challengeNonce: Uint8Array;
  writerPublicKey: Uint8Array;
  releasePolicyVersion: number;
  restored: WireHead | null;
}

export interface CommitPayload {
  deployment: string;
  epoch: number;
  operationId: string;
  expectedSequence: number;
  priorDigest: string | null;
  head: WireHead;
}

export interface StatementPayload {
  authorityKeyId: string;
  deployment: string;
  callerNonce: Uint8Array;
  issuedAtUnixMs: number;
  activeEpoch: number;
  activeWriterPublicKey: Uint8Array;
  releasePolicyVersion: number;
  sequence: number;
  head: WireHead | null;
  currentOperationId: string | null;
}

export function encodeActivate(m: ActivatePayload): Uint8Array {
  const e = new Encoder(TAG_ACTIVATE);
  e.text("deployment", m.deployment);
  e.text("challengeId", m.challengeId);
  e.bytes("challengeNonce", m.challengeNonce);
  e.bytes("writerPublicKey", m.writerPublicKey);
  e.u32("releasePolicyVersion", m.releasePolicyVersion);
  e.optHead(m.restored);
  return e.finish();
}

export function decodeActivate(payload: Uint8Array): ActivatePayload {
  const d = new Decoder(payload, TAG_ACTIVATE);
  const m: ActivatePayload = {
    deployment: d.text("deployment"),
    challengeId: d.text("challengeId"),
    challengeNonce: d.bytes("challengeNonce"),
    writerPublicKey: d.bytes("writerPublicKey"),
    releasePolicyVersion: d.u32("releasePolicyVersion"),
    restored: d.optHead(),
  };
  d.finish();
  return m;
}

export function encodeCommit(m: CommitPayload): Uint8Array {
  const e = new Encoder(TAG_COMMIT);
  e.text("deployment", m.deployment);
  e.u64("epoch", m.epoch);
  e.text("operationId", m.operationId);
  e.u64("expectedSequence", m.expectedSequence);
  e.optDigest("priorDigest", m.priorDigest);
  e.head(m.head);
  return e.finish();
}

export function decodeCommit(payload: Uint8Array): CommitPayload {
  const d = new Decoder(payload, TAG_COMMIT);
  const m: CommitPayload = {
    deployment: d.text("deployment"),
    epoch: d.u64("epoch"),
    operationId: d.text("operationId"),
    expectedSequence: d.u64("expectedSequence"),
    priorDigest: d.optDigest("priorDigest"),
    head: d.head(),
  };
  d.finish();
  return m;
}

export function encodeStatement(m: StatementPayload): Uint8Array {
  const e = new Encoder(TAG_STATEMENT);
  e.text("authorityKeyId", m.authorityKeyId);
  e.text("deployment", m.deployment);
  e.bytes("callerNonce", m.callerNonce);
  e.u64("issuedAtUnixMs", m.issuedAtUnixMs);
  e.u64("activeEpoch", m.activeEpoch);
  e.bytes("activeWriterPublicKey", m.activeWriterPublicKey);
  e.u32("releasePolicyVersion", m.releasePolicyVersion);
  e.u64("sequence", m.sequence);
  e.optHead(m.head);
  e.optText("currentOperationId", m.currentOperationId);
  return e.finish();
}

export function decodeStatement(payload: Uint8Array): StatementPayload {
  const d = new Decoder(payload, TAG_STATEMENT);
  const m: StatementPayload = {
    authorityKeyId: d.text("authorityKeyId"),
    deployment: d.text("deployment"),
    callerNonce: d.bytes("callerNonce"),
    issuedAtUnixMs: d.u64("issuedAtUnixMs"),
    activeEpoch: d.u64("activeEpoch"),
    activeWriterPublicKey: d.bytes("activeWriterPublicKey"),
    releasePolicyVersion: d.u32("releasePolicyVersion"),
    sequence: d.u64("sequence"),
    head: d.optHead(),
    currentOperationId: d.optText("currentOperationId"),
  };
  d.finish();
  return m;
}

class Encoder {
  private readonly chunks: Uint8Array[] = [];

  constructor(tag: string) {
    this.text("tag", tag);
    this.chunks.push(Uint8Array.of(VERSION));
  }

  u32(field: string, v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`wire: ${field} must be a 32-bit unsigned integer`);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    this.chunks.push(b);
  }

  u64(field: string, v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`wire: ${field} must be a non-negative safe integer`);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v));
    this.chunks.push(b);
  }

  bytes(field: string, b: Uint8Array): void {
    if (b.length > 0xffff) throw new Error(`wire: ${field} is longer than 65535 bytes`);
    const length = new Uint8Array(2);
    new DataView(length.buffer).setUint16(0, b.length);
    this.chunks.push(length, Uint8Array.from(b));
  }

  text(field: string, s: string): void {
    if (!PRINTABLE_ASCII.test(s)) throw new Error(`wire: ${field} must be printable ASCII`);
    this.bytes(field, Buffer.from(s, "latin1"));
  }

  digest(field: string, h: string): void {
    if (!DIGEST.test(h)) throw new Error(`wire: ${field} must be 64 lowercase hex characters`);
    this.chunks.push(Buffer.from(h, "hex"));
  }

  optDigest(field: string, h: string | null): void {
    this.chunks.push(Uint8Array.of(h === null ? 0 : 1));
    if (h !== null) this.digest(field, h);
  }

  optText(field: string, s: string | null): void {
    this.chunks.push(Uint8Array.of(s === null ? 0 : 1));
    if (s !== null) this.text(field, s);
  }

  optHead(h: WireHead | null): void {
    this.chunks.push(Uint8Array.of(h === null ? 0 : 1));
    if (h !== null) this.head(h);
  }

  head(h: WireHead): void {
    if (h.key !== `${h.prefix}/${h.ciphertextDigest}${SNAPSHOT_SUFFIX}`) throw new Error("wire: head.key does not name its ciphertext digest");
    this.text("head.schema", h.schema);
    this.text("head.prefix", h.prefix);
    this.u32("head.schemaVersion", h.schemaVersion);
    this.u64("head.sealEpoch", h.sealEpoch);
    this.u64("head.sequence", h.sequence);
    this.optDigest("head.previousDigest", h.previousDigest);
    this.digest("head.digest", h.digest);
    this.u64("head.size", h.size);
    this.digest("head.ciphertextDigest", h.ciphertextDigest);
    this.text("head.key", h.key);
  }

  finish(): Uint8Array {
    return Buffer.concat(this.chunks);
  }
}

class Decoder {
  private off = 0;

  constructor(private readonly buf: Uint8Array, tag: string) {
    const got = this.text("tag");
    if (got !== tag) throw new Error(`wire: tag is ${JSON.stringify(got)}, want ${JSON.stringify(tag)}`);
    const version = this.u8("version");
    if (version !== VERSION) throw new Error(`wire: version is ${version}, want ${VERSION}`);
  }

  private take(field: string, n: number): Uint8Array {
    if (this.buf.length - this.off < n) throw new Error(`wire: ${field} is truncated`);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return b;
  }

  private view(field: string, n: number): DataView {
    const b = this.take(field, n);
    return new DataView(b.buffer, b.byteOffset, n);
  }

  u8(field: string): number {
    return this.view(field, 1).getUint8(0);
  }

  u32(field: string): number {
    return this.view(field, 4).getUint32(0);
  }

  u64(field: string): number {
    const v = this.view(field, 8).getBigUint64(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`wire: ${field} exceeds 2^53-1`);
    return Number(v);
  }

  bytes(field: string): Uint8Array {
    const length = this.view(field, 2).getUint16(0);
    return Uint8Array.from(this.take(field, length));
  }

  text(field: string): string {
    const s = Buffer.from(this.bytes(field)).toString("latin1");
    if (!PRINTABLE_ASCII.test(s)) throw new Error(`wire: ${field} must be printable ASCII`);
    return s;
  }

  digest(field: string): string {
    return Buffer.from(this.take(field, 32)).toString("hex");
  }

  private present(field: string): boolean {
    const flag = this.u8(field);
    if (flag > 1) throw new Error(`wire: ${field} has an invalid presence byte`);
    return flag === 1;
  }

  optDigest(field: string): string | null {
    return this.present(field) ? this.digest(field) : null;
  }

  optText(field: string): string | null {
    return this.present(field) ? this.text(field) : null;
  }

  optHead(): WireHead | null {
    return this.present("head") ? this.head() : null;
  }

  head(): WireHead {
    const h: WireHead = {
      schema: this.text("head.schema"),
      prefix: this.text("head.prefix"),
      schemaVersion: this.u32("head.schemaVersion"),
      sealEpoch: this.u64("head.sealEpoch"),
      sequence: this.u64("head.sequence"),
      previousDigest: this.optDigest("head.previousDigest"),
      digest: this.digest("head.digest"),
      size: this.u64("head.size"),
      ciphertextDigest: this.digest("head.ciphertextDigest"),
      key: this.text("head.key"),
    };
    if (h.key !== `${h.prefix}/${h.ciphertextDigest}${SNAPSHOT_SUFFIX}`) throw new Error("wire: head.key does not name its ciphertext digest");
    return h;
  }

  finish(): void {
    if (this.off !== this.buf.length) throw new Error("wire: payload has trailing bytes");
  }
}
