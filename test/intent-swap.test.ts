import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ArkAddress, toXOnly } from "@arkade-os/sdk";
import { createIntentSwapCreator, type OfflineSwapCreator } from "../src/intent-swap.js";
import { receiveVtxoScript, unilateralClaimDelay } from "../src/vendor/arkade-swap/rfq.js";
import { buildInvoice } from "./helpers/bolt11.js";

// Integration test of the real corridor creator against fake solver / covclaimd /
// operator services over real HTTP (repo style, no module mocks). The fake solver
// derives the same covenant a real solver would, from the request's profile fields.

const UNILATERAL_EXIT_DELAY = 86400;
const covclaimdPub = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const emulatorPub = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const solverPub = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const operatorPub = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const operatorXonly = toXOnly(hex.decode(operatorPub), "operator");
const solverRefundPkScript = new Uint8Array([0x51, 0x20, ...secp256k1.utils.randomSecretKey()]);
const RECEIVE = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();
const CLAIM_PUBKEY = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));

function serve(handler: http.RequestListener): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(JSON.parse(d)));
  });
}

interface FakeSolver {
  baseUrl: string;
  requests: Record<string, any>[];
  statuses: Map<string, string>;
  mode: { wrongHash?: boolean; fromAmountDelta?: number; bogusLockup?: boolean };
  close: () => Promise<void>;
}

async function startFakeSolver(): Promise<FakeSolver> {
  const requests: Record<string, any>[] = [];
  const statuses = new Map<string, string>();
  const mode: FakeSolver["mode"] = {};
  const { baseUrl, close } = await serve(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v1/swap") {
      const r = await readBody(req);
      requests.push(r);
      const now = Math.floor(Date.now() / 1000);
      const refundLocktime = now + 7200;
      const paymentHash = mode.wrongHash ? "ff".repeat(32) : r.profile.payment_hash;
      // The payer commits to `amount` (amount_side "from"); the invoice names exactly it.
      const invoice = buildInvoice(paymentHash, { amountHrp: `${r.amount * 10000}p`, timestamp: now });
      const script = receiveVtxoScript({
        solverPubkey: toXOnly(hex.decode(solverPub), "solver"),
        refundLocktime,
        serverPubkey: operatorXonly,
        paymentHash: r.profile.payment_hash,
        claimDelay: unilateralClaimDelay(UNILATERAL_EXIT_DELAY),
        emulatorPubkey: toXOnly(hex.decode(emulatorPub), "emulator"),
        solverRefundPkScript,
        payoutPubkey: hex.decode(r.profile.payout_pubkey),
        payoutPkScript: ArkAddress.decode(r.profile.payout_address).pkScript,
      });
      const lockupAddress = mode.bogusLockup ? "tark1qbogus" : script.address("tark", operatorXonly).encode();
      res.end(
        JSON.stringify({
          v: 1,
          type: "rfq_quote",
          rfq_id: r.rfq_id,
          pair: r.pair,
          from_amount: r.amount + (mode.fromAmountDelta ?? 0),
          to_amount: r.amount - 1,
          solver_pubkey: solverPub,
          valid_until: now + 600,
          refund_locktime: refundLocktime,
          profile: {
            payment_hash: r.profile.payment_hash,
            invoice,
            solver_refund_pk_script: hex.encode(solverRefundPkScript),
            lockup_address: lockupAddress,
          },
        }),
      );
      return;
    }
    const statusMatch = /^\/v1\/rfq\/([0-9a-f]+)$/.exec(req.url ?? "");
    if (req.method === "GET" && statusMatch) {
      const state = statuses.get(statusMatch[1]);
      if (!state) {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ v: 1, type: "rfq_status", rfq_id: statusMatch[1], state, updated_at: Math.floor(Date.now() / 1000), profile: {} }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { baseUrl, requests, statuses, mode, close };
}

let covclaimd: { baseUrl: string; close: () => Promise<void> };
let operator: { baseUrl: string; close: () => Promise<void> };
let solver: FakeSolver;
let creator: OfflineSwapCreator;

beforeAll(async () => {
  [covclaimd, operator, solver] = await Promise.all([
    serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/preimage/covclaimd-pubkey") {
        res.end(JSON.stringify({ covclaimd_pub_key: covclaimdPub, emulator_pub_key: emulatorPub }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }),
    serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/info") {
        res.end(JSON.stringify({ network: "mutinynet", signerPubkey: operatorPub, unilateralExitDelay: String(UNILATERAL_EXIT_DELAY) }));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }),
    startFakeSolver(),
  ]);
  creator = await createIntentSwapCreator({ solverUrl: solver.baseUrl, covclaimdUrl: covclaimd.baseUrl, arkServerUrl: operator.baseUrl });
});

afterAll(async () => {
  await Promise.all([covclaimd.close(), operator.close(), solver.close()]);
});

describe("createIntentSwapCreator", () => {
  it("quotes a corridor receive and returns the solver's hold invoice", async () => {
    const swap = await creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });

    expect(swap.preimageHash).toBe(createHash("sha256").update(Buffer.from(swap.preimage, "hex")).digest("hex"));
    expect(swap.swapId).toMatch(/^[0-9a-f]{64}$/);
    expect(swap.invoice).toMatch(/^lnbc500000p1/);

    const r = solver.requests[0];
    expect(r.type).toBe("rfq_request");
    expect(r.pair).toBe("lightning:BTC->arkade:BTC");
    expect(r.amount_side).toBe("from");
    expect(r.amount).toBe(50);
    expect(r.profile.payment_hash).toBe(swap.preimageHash);
    expect(r.profile.payout_address).toBe(RECEIVE);
    expect(r.profile.payout_pubkey).toBe(CLAIM_PUBKEY.slice(2));
    expect(typeof r.profile.claim_packet).toBe("string");
    // Default off: the bare 93-byte ciphertext an older solver forwards as-is.
    expect(base64.decode(r.profile.claim_packet)).toHaveLength(93);
    // The covenant derivation agrees with the solver's, so the quoted lockup passes.
    expect(swap.lockupAddress).toMatch(/^tark1/);
  });

  it("sends the stampable packet, naming our covclaimd, when asked to", async () => {
    const stamping = await createIntentSwapCreator({
      solverUrl: solver.baseUrl,
      covclaimdUrl: covclaimd.baseUrl,
      arkServerUrl: operator.baseUrl,
      stampClaimPacket: true,
    });
    await stamping.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });

    const packet = base64.decode(solver.requests.at(-1)!.profile.claim_packet);
    expect(packet.length).toBeGreaterThan(93);
    expect(packet[0]).toBe(0x01);
    const ciphertextLength = (packet[1]! << 8) | packet[2]!;
    expect(ciphertextLength).toBe(93);
    const pubkeyTlvAt = 3 + ciphertextLength;
    expect(packet[pubkeyTlvAt]).toBe(0x03);
    expect((packet[pubkeyTlvAt + 1]! << 8) | packet[pubkeyTlvAt + 2]!).toBe(33);
    // Ends there: no 0x02, which the solver appends from the covenant it builds.
    expect(packet).toHaveLength(pubkeyTlvAt + 3 + 33);
  });

  it("registers the lockup for self-claim without touching the quote's receiver role", async () => {
    const registrations: { swapId: string; expectedAmount: number; lockup: string }[] = [];
    const selfClaiming = await createIntentSwapCreator({
      solverUrl: solver.baseUrl,
      covclaimdUrl: covclaimd.baseUrl,
      arkServerUrl: operator.baseUrl,
      selfClaimer: {
        register: (r) =>
          registrations.push({ swapId: r.swapId, expectedAmount: r.expectedAmount, lockup: r.script.address("tark", operatorXonly).encode() }),
        claim: async () => ({ state: "skipped", reason: "unfunded" }),
      },
    });

    const swap = await selfClaiming.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });

    const r = solver.requests.at(-1)!;
    // The user keeps the receiver role, and with it their own claim paths.
    expect(r.profile.payout_pubkey).toBe(CLAIM_PUBKEY.slice(2));
    expect(r.profile.payout_address).toBe(RECEIVE);
    expect(registrations).toEqual([{ swapId: swap.swapId, expectedAmount: 49, lockup: swap.lockupAddress }]);
    expect(typeof selfClaiming.selfClaim).toBe("function");
    // Absent without a claimer, so the poller can tell the two builds apart.
    expect(creator.selfClaim).toBeUndefined();
  });

  it("follows solver status for isSettled", async () => {
    const swap = await creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY });
    expect(await creator.isSettled(swap.swapId)).toBe(false); // 404 → unknown
    solver.statuses.set(swap.swapId, "funded");
    expect(await creator.isSettled(swap.swapId)).toBe(false);
    solver.statuses.set(swap.swapId, "settled");
    expect(await creator.isSettled(swap.swapId)).toBe(true);
  });

  it("refuses an invoice on a different payment hash", async () => {
    solver.mode.wrongHash = true;
    try {
      await expect(creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY })).rejects.toThrow(/pays/);
    } finally {
      solver.mode.wrongHash = false;
    }
  });

  it("refuses a quote whose from_amount is not the requested amount", async () => {
    solver.mode.fromAmountDelta = 7;
    try {
      await expect(creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY })).rejects.toThrow(/from_amount/);
    } finally {
      solver.mode.fromAmountDelta = undefined;
    }
  });

  it("refuses a quote whose lockup address doesn't match the local derivation", async () => {
    solver.mode.bogusLockup = true;
    try {
      await expect(creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY })).rejects.toThrow();
    } finally {
      solver.mode.bogusLockup = false;
    }
  });

  it("rejects a malformed claimPublicKey and a wrong-network address", async () => {
    const requestsBefore = solver.requests.length;
    await expect(creator.create({ amountSat: 50, receiveAddress: RECEIVE, claimPublicKey: "04" + "ab".repeat(32) })).rejects.toThrow(/claimPublicKey/);
    const mainnetAddr = new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "ark").encode();
    await expect(creator.create({ amountSat: 50, receiveAddress: mainnetAddr, claimPublicKey: CLAIM_PUBKEY })).rejects.toThrow(/prefix|network/i);
    expect(solver.requests).toHaveLength(requestsBefore); // neither attempt reached the solver
  });

  it("rejects out-of-bounds amounts with the card's numbers when discovered from a registry", async () => {
    // A registry index whose only lightning-corridor card is bounded 1000–25000 sats.
    // Its transport points nowhere usable — discovery alone is what we're proving.
    const registry = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          markets: [
            {
              pair: "BTC/lightning:BTC",
              quote_corridor: "lightning",
              fee_bps: 30,
              min_base_amount: "1000",
              max_base_amount: "50000",
              min_quote_amount: "1000",
              max_quote_amount: "25000",
              solver: "card-solver",
              discovery_pubkey: "aa".repeat(32), // x-only Nostr pubkey
              transports: { nostr: { relays: ["wss://relay.invalid"] } },
            },
          ],
        }),
      );
    });
    try {
      const discovered = await createIntentSwapCreator({ registryUrl: registry.baseUrl, covclaimdUrl: covclaimd.baseUrl, arkServerUrl: operator.baseUrl });
      await expect(discovered.create({ amountSat: 500, receiveAddress: RECEIVE, claimPublicKey: CLAIM_PUBKEY })).rejects.toThrow(/1000–25000/);
    } finally {
      await registry.close();
    }
  });

  it("throws at construction when discovery finds no lightning corridor", async () => {
    const registry = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ markets: [{ pair: "BTC/USDT", fee_bps: 30 }] }));
    });
    try {
      await expect(createIntentSwapCreator({ registryUrl: registry.baseUrl, covclaimdUrl: covclaimd.baseUrl, arkServerUrl: operator.baseUrl })).rejects.toThrow(/no lightning-corridor/);
    } finally {
      await registry.close();
    }
  });
});
