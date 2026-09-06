import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ArkAddress,
  ConditionWitness,
  CSVMultisigTapscript,
  Extension,
  PrevArkTxField,
  Transaction,
  getArkPsbtFields,
  scriptFromTapLeafScript,
  toXOnly,
} from "@arkade-os/sdk";
import { createSelfClaimer } from "../src/self-claim.js";
import { receiveVtxoScript, unilateralClaimDelay } from "../src/vendor/arkade-swap/rfq.js";

// Against a fake Arkade operator + emulator over real HTTP, repo style. The fake
// echoes, so what these prove is the tx WE build: leaf, destination, no signature.

const UNILATERAL_EXIT_DELAY = 86_400;
const operatorPub = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true));
const operatorXonly = toXOnly(hex.decode(operatorPub), "operator");
const emulatorXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "emulator");
const solverXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "solver");
const solverRefundPkScript = new Uint8Array([0x51, 0x20, ...secp256k1.utils.randomSecretKey()]);
// A real x-only point: this becomes a taproot OUTPUT, and btc-signer rejects the
// off-curve key that 32 random bytes are half the time.
const payoutXonly = toXOnly(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), "payout");
const PAYOUT = new ArkAddress(operatorXonly, payoutXonly, "tark").encode();
const PAYOUT_PKSCRIPT = ArkAddress.decode(PAYOUT).pkScript;
const CHECKPOINT_TAPSCRIPT = hex.encode(
  CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 1024n }, pubkeys: [operatorXonly] }).script,
);

const PREIMAGE = randomBytes(32);
const PAYMENT_HASH = createHash("sha256").update(PREIMAGE).digest("hex");
const REFUND_LOCKTIME = Math.floor(Date.now() / 1000) + 7200;

let ark: { baseUrl: string; close: () => Promise<void> };
let vtxos: ReturnType<typeof wireVtxo>[];
let virtualTxs: Map<string, string>;
let submitted: { arkTx: string; checkpointTxs: string[] }[];

/** Keyed by the txid it actually hashes to, so PrevArkTx resolution can find it. */
function fundingTx(lockupPkScript: Uint8Array, valueSat: number): { txid: string; psbt: string } {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
  tx.addInput({ txid: randomBytes(32), index: 0 });
  tx.addOutput({ script: lockupPkScript, amount: BigInt(valueSat) });
  return { txid: tx.id, psbt: base64.encode(tx.toPSBT()) };
}

function wireVtxo(opts: { txid: string; valueSat: number; script: string }) {
  return {
    outpoint: { txid: opts.txid, vout: 0 },
    amount: String(opts.valueSat),
    createdAt: String(Math.floor(Date.now() / 1000)),
    script: opts.script,
    isSpent: false,
    isSwept: false,
    isPreconfirmed: true,
    commitmentTxids: [],
    spentBy: "",
    settledBy: "",
    arkTxid: opts.txid,
    isUnrolled: false,
    expiresAt: String(Math.floor(Date.now() / 1000) + 86_400),
  };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(JSON.parse(d)));
  });
}

beforeAll(async () => {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/v1/info") {
      res.end(
        JSON.stringify({
          network: "mutinynet",
          signerPubkey: operatorPub,
          forfeitPubkey: operatorPub,
          unilateralExitDelay: String(UNILATERAL_EXIT_DELAY),
          checkpointTapscript: CHECKPOINT_TAPSCRIPT,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/indexer/vtxos") {
      const scripts = url.searchParams.getAll("scripts");
      res.end(JSON.stringify({ vtxos: vtxos.filter((v) => scripts.includes(v.script)), page: { current: 1, next: 1, total: 1 } }));
      return;
    }
    const virtual = /^\/v1\/indexer\/virtualTx\/(.+)$/.exec(url.pathname);
    if (virtual) {
      const txs = decodeURIComponent(virtual[1]!).split(",").map((id) => virtualTxs.get(id)).filter(Boolean);
      res.end(JSON.stringify({ txs, page: { current: 1, next: 1, total: 1 } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/tx") {
      const body = (await readBody(req)) as { arkTx: string; checkpointTxs: string[] };
      submitted.push(body);
      res.end(JSON.stringify({ signedArkTx: body.arkTx, signedCheckpointTxs: body.checkpointTxs }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  ark = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
});
afterAll(() => ark.close());
beforeEach(() => {
  vtxos = [];
  virtualTxs = new Map();
  submitted = [];
});

/** A claimer plus the lockup a solver would have funded for it. */
function registered(opts: { swapId: string; expectedAmount: number }) {
  const claimer = createSelfClaimer({ arkServerUrl: ark.baseUrl, emulatorUrl: ark.baseUrl });
  const script = receiveVtxoScript({
    solverPubkey: solverXonly,
    refundLocktime: REFUND_LOCKTIME,
    serverPubkey: operatorXonly,
    paymentHash: PAYMENT_HASH,
    claimDelay: unilateralClaimDelay(UNILATERAL_EXIT_DELAY),
    emulatorPubkey: emulatorXonly,
    solverRefundPkScript,
    payoutPubkey: payoutXonly,
    payoutPkScript: PAYOUT_PKSCRIPT,
  });
  claimer.register({ swapId: opts.swapId, script, expectedAmount: opts.expectedAmount });
  return { claimer, script, lockupScript: hex.encode(script.pkScript) };
}

function funded(opts: { swapId: string; expectedAmount: number; valueSat: number }) {
  const r = registered(opts);
  const { txid, psbt } = fundingTx(r.script.pkScript, opts.valueSat);
  virtualTxs.set(txid, psbt);
  vtxos.push(wireVtxo({ txid, valueSat: opts.valueSat, script: r.lockupScript }));
  return { ...r, txid };
}

describe("createSelfClaimer", () => {
  it("pushes the covenant-pinned nonInteractiveClaim leaf, signing nothing itself", async () => {
    const { claimer, script, txid } = funded({ swapId: "swap-1", expectedAmount: 4_900, valueSat: 4_900 });

    const outcome = await claimer.claim("swap-1", hex.encode(PREIMAGE));

    expect(outcome).toMatchObject({ state: "claimed" });
    expect(submitted).toHaveLength(1);

    const checkpoint = Transaction.fromPSBT(base64.decode(submitted[0].checkpointTxs[0]));
    expect(hex.encode(checkpoint.getInput(0).txid!)).toBe(txid);
    const [nicLeaf, arkadeScript] = script.nonInteractiveClaim();
    expect(hex.encode(scriptFromTapLeafScript(checkpoint.getInput(0).tapLeafScript![0]))).toBe(
      hex.encode(scriptFromTapLeafScript(nicLeaf)),
    );
    // Not the unconstrained collaborative leaf, which would let us pay anywhere.
    expect(hex.encode(scriptFromTapLeafScript(nicLeaf))).not.toBe(hex.encode(scriptFromTapLeafScript(script.claim())));

    const arkTx = Transaction.fromPSBT(base64.decode(submitted[0].arkTx));
    // No key of ours is in the leaf, so nothing here is ours to sign.
    expect(arkTx.getInput(0).tapScriptSig ?? []).toHaveLength(0);
    expect(getArkPsbtFields(arkTx, 0, ConditionWitness)[0]?.map(hex.encode)).toEqual([hex.encode(PREIMAGE)]);
    expect(getArkPsbtFields(checkpoint, 0, ConditionWitness)[0]?.map(hex.encode)).toEqual([hex.encode(PREIMAGE)]);
    expect(getArkPsbtFields(arkTx, 0, PrevArkTxField)).toHaveLength(1);

    // Output 0 is what the covenant checks, and it is the covenant's own receiverPkScript.
    expect(hex.encode(arkTx.getOutput(0).script!)).toBe(
      hex.encode(script.options.nonInteractiveParameters!.receiverPkScript),
    );
    expect(hex.encode(arkTx.getOutput(0).script!)).toBe(hex.encode(PAYOUT_PKSCRIPT));
    expect(arkTx.getOutput(0).amount).toBe(4_900n);

    // Output 1 carries the emulator packet naming the covenant script it must run.
    const ext = arkTx.getOutput(1).script!;
    expect(Extension.isExtension(ext)).toBe(true);
    const entries = Extension.fromBytes(ext).getEmulatorPacket()!.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].vin).toBe(0);
    expect(hex.encode(entries[0].script)).toBe(hex.encode(arkadeScript));
  });

  it("skips, and submits nothing, when the lockup is already spent or not yet funded", async () => {
    const { claimer } = registered({ swapId: "swap-2", expectedAmount: 4_900 });

    expect(await claimer.claim("swap-2", hex.encode(PREIMAGE))).toEqual({ state: "skipped", reason: "unfunded" });
    expect(submitted).toHaveLength(0);
  });

  it("is idempotent: a retry after a successful claim submits nothing more", async () => {
    const { claimer } = funded({ swapId: "swap-3", expectedAmount: 4_900, valueSat: 4_900 });

    expect((await claimer.claim("swap-3", hex.encode(PREIMAGE))).state).toBe("claimed");
    expect(await claimer.claim("swap-3", hex.encode(PREIMAGE))).toEqual({ state: "skipped", reason: "unregistered" });
    expect(submitted).toHaveLength(1);
  });

  it("refuses to reveal the preimage for a lockup funded below the quoted amount", async () => {
    const { claimer } = funded({ swapId: "swap-4", expectedAmount: 4_900, valueSat: 4_899 });

    expect(await claimer.claim("swap-4", hex.encode(PREIMAGE))).toEqual({ state: "skipped", reason: "underfunded" });
    expect(submitted).toHaveLength(0);
  });

  it("skips a swap it never quoted (nothing to rebuild the covenant from)", async () => {
    const { claimer } = registered({ swapId: "swap-5", expectedAmount: 4_900 });

    expect(await claimer.claim("never-seen", hex.encode(PREIMAGE))).toEqual({ state: "skipped", reason: "unregistered" });
    expect(submitted).toHaveLength(0);
  });
});
