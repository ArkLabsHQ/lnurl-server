import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { ArkAddress } from "@arkade-os/sdk";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { createRepositories, type Repositories } from "../src/db/repositories/index.js";
import { AddressService } from "../src/address-service.js";
import { OwnerSetupError, OwnerSetupService } from "../src/owner-setup-service.js";
import { deriveSessionId } from "../src/session-id.js";
import { encodeOwnerSetup, ownerSetupDigest, type OwnerSetup } from "../src/enclave/owner-setup.js";

const ownerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const nextKey = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
const strangerKey = Uint8Array.from({ length: 32 }, (_, i) => i + 80);
const pub = (key: Uint8Array) => bytesToHex(schnorr.getPublicKey(key));
const destination = (n: number) => new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(n), "tark").encode();
const token = () => randomBytes(32).toString("hex");

const FIRST: OwnerSetup = {
  intent: "set", deployment: "lnurl-test", tenant: "wallet.example", network: "regtest",
  domain: "wallet.example", username: "alice", ownerPublicKey: pub(ownerKey), arkadeDestination: destination(3),
  claimPublicKey: "02" + "ab".repeat(32), rails: ["arkade", "offline-swap"], revision: 1,
};

const digest = (s: OwnerSetup) => bytesToHex(ownerSetupDigest(s));
const signed = (s: OwnerSetup, key = ownerKey) => ({ payload: encodeOwnerSetup(s), signature: schnorr.sign(ownerSetupDigest(s), key) });
const after = (prev: OwnerSetup, change: Partial<OwnerSetup>): OwnerSetup => ({ ...prev, ...change, revision: prev.revision + 1, previousHash: digest(prev) });

let db: Db;
let repos: Repositories;
let service: OwnerSetupService;
beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db);
  repos = createRepositories(db);
  repos.domains.create({ domain: "wallet.example", allocationModes: ["self"] });
  service = new OwnerSetupService(repos, new AddressService(repos, randomBytes(32)), { deployment: "lnurl-test", network: "regtest", enrollment: true });
});

function refused(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OwnerSetupError);
    expect((e as OwnerSetupError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but it was accepted`);
}

describe("OwnerSetupService", () => {
  it("enrolls at revision 1 under the payload's own key, writing the payout through for advertising", () => {
    const t = token();
    const out = service.submit({ ...signed(FIRST), token: t });
    expect(out).toMatchObject({ applied: true, identity: { currentRevision: 1, currentDigest: digest(FIRST), state: "active" } });
    const address = repos.addresses.getById(out.identity.addressId!)!;
    expect(address).toMatchObject({ username: "alice", sessionId: deriveSessionId(t), arkadeAddress: FIRST.arkadeDestination, claimPublicKey: FIRST.claimPublicKey });
    expect(address.disabledRails).toEqual(["interactive-lightning", "covenant", "onchain"]);
    expect(service.current("wallet.example", "alice")?.setup).toEqual(FIRST);
  });

  it("answers a repeated submission idempotently", () => {
    const first = signed(FIRST);
    service.submit({ ...first, token: token() });
    expect(service.submit({ ...first, token: token() })).toMatchObject({ applied: false, identity: { currentRevision: 1 } });
    expect(repos.ownerSetups.history("wallet.example", "alice", 10)).toHaveLength(1);
  });

  it("updates only under the committed owner key, chained from the committed head", () => {
    service.submit({ ...signed(FIRST), token: token() });
    const second = after(FIRST, { arkadeDestination: destination(4) });
    refused(() => service.submit(signed(second, strangerKey)), "bad_signature");
    refused(() => service.submit(signed({ ...second, previousHash: "cd".repeat(32) })), "revision_conflict");
    refused(() => service.submit(signed({ ...second, revision: 3 })), "revision_conflict");
    expect(service.submit(signed(second))).toMatchObject({ applied: true, identity: { currentRevision: 2 } });
    expect(repos.addresses.getById(service.current("wallet.example", "alice")!.identity.addressId!)?.arkadeAddress).toBe(destination(4));
  });

  it("rotates only when the old owner signs and the new owner countersigns", () => {
    service.submit({ ...signed(FIRST), token: token() });
    const rotation = after(FIRST, { ownerPublicKey: pub(nextKey) });
    refused(() => service.submit(signed(rotation, nextKey)), "bad_signature");
    refused(() => service.submit(signed(rotation)), "countersignature_required");
    refused(() => service.submit({ ...signed(rotation), countersignature: schnorr.sign(ownerSetupDigest(rotation), strangerKey) }), "bad_signature");
    const out = service.submit({ ...signed(rotation), countersignature: schnorr.sign(ownerSetupDigest(rotation), nextKey) });
    expect(bytesToHex(out.identity.ownerPublicKey)).toBe(pub(nextKey));
    expect(out.record).toMatchObject({ intent: "rotate" });
    expect(bytesToHex(out.record.signerPublicKey)).toBe(pub(ownerKey));
    refused(() => service.submit(signed(after(rotation, { arkadeDestination: destination(5) }))), "bad_signature");
  });

  it("refuses a setup for another deployment, tenant or network", () => {
    refused(() => service.submit({ ...signed({ ...FIRST, deployment: "lnurl-other" }), token: token() }), "wrong_deployment");
    refused(() => service.submit({ ...signed({ ...FIRST, tenant: "another-provider" }), token: token() }), "wrong_tenant");
    refused(() => service.submit({ ...signed({ ...FIRST, network: "bitcoin" }), token: token() }), "wrong_network");
    refused(() => service.submit({ ...signed({ ...FIRST, domain: "elsewhere.example" }), token: token() }), "unknown_domain");
  });

  it("refuses interactive-lightning, which a protected address never routes through", () => {
    refused(() => service.submit({ ...signed({ ...FIRST, rails: ["arkade", "interactive-lightning"] }), token: token() }), "unsupported_rail");
  });

  it("records a revocation as a signed revision, and lets the last owner come back", () => {
    service.submit({ ...signed(FIRST), token: token() });
    const revoke = after(FIRST, { intent: "revoke" });
    refused(() => service.submit(signed({ ...revoke, arkadeDestination: destination(6) })), "invalid_payload");
    expect(service.submit(signed(revoke))).toMatchObject({ identity: { state: "revoked", currentRevision: 2 } });
    refused(() => service.submit(signed(after(revoke, { intent: "revoke" }))), "already_revoked");
    expect(service.submit(signed(after(revoke, { intent: "set" })))).toMatchObject({ identity: { state: "active", currentRevision: 3 } });
  });

  it("gives an old credential nothing, and enrolls no name a legacy address holds", () => {
    const legacy = token();
    const domainId = repos.domains.getByDomain("wallet.example")!.id;
    repos.addresses.create({ domainId, username: "bob", status: "active", sessionId: deriveSessionId(legacy) });
    refused(() => service.submit({ ...signed(FIRST), token: legacy }), "stale_credential");
    refused(() => service.submit({ ...signed({ ...FIRST, username: "bob" }), token: token() }), "username_taken");
    refused(() => service.submit(signed(FIRST)), "invalid_token");
  });

  it("enrolls nothing while enrollment is closed, yet still advances an existing identity", () => {
    service.submit({ ...signed(FIRST), token: token() });
    const closed = new OwnerSetupService(repos, new AddressService(repos, randomBytes(32)), { deployment: "lnurl-test", network: "regtest", enrollment: false });
    refused(() => closed.submit({ ...signed({ ...FIRST, username: "carol" }), token: token() }), "enrollment_disabled");
    expect(closed.submit(signed(after(FIRST, { arkadeDestination: destination(7) })))).toMatchObject({ applied: true });
  });

  it("commits an enrollment's address and identity together, or neither", () => {
    db.prepare(
      `INSERT INTO owner_setups (domain, username, tenant, revision, digest, intent, payload, signature, signer_public_key, owner_public_key, accepted_at)
       VALUES ('elsewhere', 'x', 't', 1, ?, 'enroll', x'00', x'00', x'00', x'00', 0)`,
    ).run(digest(FIRST));
    expect(() => service.submit({ ...signed(FIRST), token: token() })).toThrow();
    const domainId = repos.domains.getByDomain("wallet.example")!.id;
    expect(repos.addresses.getByDomainAndUsername(domainId, "alice")).toBeUndefined();
    expect(repos.ownerSetups.identity("wallet.example", "alice")).toBeUndefined();
  });
});
