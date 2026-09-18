import { describe, it, expect, vi } from "vitest";
import { ArkAddress, type IContractManager } from "@arkade-os/sdk";
import { SWAP_LOCKUP_CONTRACT_TYPE } from "@arkade-os/swap";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { startLockupWatcher } from "../src/lockup-watcher.js";
import { startOfflineSettlementPoller } from "../src/offline-poller.js";
import { DbSettlementStore } from "../src/settlement-store.js";
import { OfflineSwapStore } from "../src/offline-swap-store.js";
import type { OfflineSwapCreator } from "../src/intent-swap.js";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";

const address = () => new ArkAddress(secp256k1.utils.randomSecretKey(), secp256k1.utils.randomSecretKey(), "tark").encode();
const scriptOf = (addr: string) => hex.encode(ArkAddress.decode(addr).pkScript);

function storeWith(lockups: string[]) {
  const db = openDb(":memory:");
  runMigrations(db);
  const swaps = new OfflineSwapStore(db, 3_600_000);
  lockups.forEach((lockupAddress, i) => {
    const hash = i.toString(16).padStart(2, "0").repeat(32);
    swaps.createAccepted({
      paymentHash: hash, pr: "lnbc1", sessionId: `offline:${i}`, preimage: "bb".repeat(32), amountMsat: 5_000_000,
      recovery: {
        version: 1, solverName: "primary", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"],
        rfqId: hash, lockupAddress, expectedAmount: 4_999, script: { sender: "33".repeat(32) },
      },
    });
  });
  return { db, swaps };
}

/** Captures the subscriber so a test can push events the way the manager would. */
function fakeManager() {
  let emit: ((e: unknown) => void) | undefined;
  const manager = {
    onContractEvent: vi.fn((cb: (e: unknown) => void) => {
      emit = cb;
      return () => { emit = undefined; };
    }),
  } as unknown as IContractManager;
  const push = (type: string, script: string, contractType = SWAP_LOCKUP_CONTRACT_TYPE) =>
    emit?.({
      type,
      contractScript: script,
      vtxos: [{ txid: "lockup-tx", value: 4_999 }],
      contract: { type: contractType, script, params: {}, address: "tark1x" },
      timestamp: Date.now(),
    });
  return { manager, push };
}

describe("startLockupWatcher", () => {
  it("settles the instant the solver funds the lockup, with no interval to wait for", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger);
    push("vtxo_received", scriptOf(lockup));

    expect(trigger).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("ignores funding at a script no pending swap is waiting on", () => {
    const { db, swaps } = storeWith([address()]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger);
    push("vtxo_received", scriptOf(address()));

    expect(trigger).not.toHaveBeenCalled();
    db.close();
  });

  it("ignores a funded contract of another type", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger);
    push("vtxo_received", scriptOf(lockup), "lnurl-covenant-destination");

    expect(trigger).not.toHaveBeenCalled();
    db.close();
  });

  // Our own claim spends the lockup, so the spend event is the echo of work already done.
  it("ignores the spend its own claim produces", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger);
    push("vtxo_spent", scriptOf(lockup));

    expect(trigger).not.toHaveBeenCalled();
    db.close();
  });

  it("stops triggering once unsubscribed", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger)();
    push("vtxo_received", scriptOf(lockup));

    expect(trigger).not.toHaveBeenCalled();
    db.close();
  });

  it("still matches other swaps when one row carries an address it cannot decode", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    db.prepare("UPDATE offline_swaps SET lockup_address = 'not-an-address' WHERE rfq_id = ?").run("00".repeat(32));
    const second = address();
    swaps.createAccepted({
      paymentHash: "cc".repeat(32), pr: "lnbc2", sessionId: "offline:2", preimage: "dd".repeat(32), amountMsat: 5_000_000,
      recovery: {
        version: 1, solverName: "primary", solverPubkey: "11".repeat(32), relays: ["wss://relay.example"],
        rfqId: "cc".repeat(32), lockupAddress: second, expectedAmount: 4_999, script: { sender: "33".repeat(32) },
      },
    });
    const { manager, push } = fakeManager();
    const trigger = vi.fn();

    startLockupWatcher(manager, swaps, trigger);
    push("vtxo_received", scriptOf(second));

    expect(trigger).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("survives a store that throws while the subscription stays live", () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const { manager, push } = fakeManager();
    const trigger = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listPending = vi.spyOn(swaps, "listPending").mockImplementationOnce(() => { throw new Error("db locked"); });

    startLockupWatcher(manager, swaps, trigger);
    expect(() => push("vtxo_received", scriptOf(lockup))).not.toThrow();
    expect(trigger).not.toHaveBeenCalled();

    listPending.mockRestore();
    push("vtxo_received", scriptOf(lockup));
    expect(trigger).toHaveBeenCalledTimes(1);

    warn.mockRestore();
    db.close();
  });
});

// The interval here is an hour, so only the funding event can account for the claim.
describe("funding event to claim", () => {
  it("claims and settles off the event alone, with no interval in reach", async () => {
    const lockup = address();
    const { db, swaps } = storeWith([lockup]);
    const settlements = new DbSettlementStore(db, 3_600_000);
    const { manager, push } = fakeManager();
    let funded = false;
    const claims: string[] = [];
    const creator: OfflineSwapCreator = {
      create: async () => { throw new Error("not used"); },
      selfClaim: async (swapId) => {
        claims.push(swapId);
        if (!funded) return { state: "skipped", reason: "unfunded" };
        return { state: "claimed", arkTxid: "ark-tx-1" };
      },
      isSettled: async () => funded,
    };

    const poller = startOfflineSettlementPoller(settlements, creator, 3_600_000, swaps);
    const unwatch = startLockupWatcher(manager, swaps, poller.trigger);
    await vi.waitFor(() => expect(claims).toHaveLength(1));
    expect(settlements.get("00".repeat(32))!.settled).toBe(false);

    funded = true;
    push("vtxo_received", scriptOf(lockup));

    await vi.waitFor(() => expect(settlements.get("00".repeat(32))!.settled).toBe(true));
    unwatch();
    poller.stop();
    db.close();
  });
});
