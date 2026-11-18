import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseTransaction, type Hex } from "viem";
import { openDb, type Db } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import { satoraSource } from "../src/rails/satora-catalogue.js";
import { createSatoraGasSponsor } from "../src/services/satora-gas.js";

const rpc = vi.hoisted(() => ({
  getBalance: vi.fn<() => Promise<bigint>>(),
  getTransactionCount: vi.fn<() => Promise<number>>(),
  getBlock: vi.fn<() => Promise<{ baseFeePerGas: bigint | null }>>(),
  estimateFeesPerGas: vi.fn<() => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>>(),
  estimateGas: vi.fn<() => Promise<bigint>>(),
  sendRawTransaction: vi.fn<(tx: { serializedTransaction: Hex }) => Promise<Hex>>(),
}));
vi.mock("../src/rails/satora-evm.js", () => ({ satoraEvmChain: () => ({ id: 1 }), satoraEvmClient: () => rpc }));

const source = satoraSource("satora-usdtethereum")!;
const deposit = "0x1111111111111111111111111111111111111111";
const secondDeposit = "0x2222222222222222222222222222222222222222";
const key = `0x${"12".repeat(32)}` as const;
let db: Db;

beforeEach(() => {
  vi.resetAllMocks();
  rpc.getBalance.mockResolvedValue(0n);
  rpc.getTransactionCount.mockResolvedValue(5);
  rpc.getBlock.mockResolvedValue({ baseFeePerGas: 1n });
  rpc.estimateGas.mockResolvedValue(21_000n);
  rpc.estimateFeesPerGas.mockResolvedValue({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  db = openDb(":memory:");
  runMigrations(db);
  const insert = db.prepare(`INSERT INTO satora_orders (
    id, verify_id, address_id, amount_sat, mnemonic, expires_at, next_poll_at, created_at, swap_id,
    payment_option, deposit_address, active
  ) VALUES (?, ?, 1, 10000, X'00', ?, 0, 1000, ?, ?, ?, 1)`);
  insert.run("first", "first", Date.now() + 60_000, "first", source.id, deposit);
  insert.run("second", "second", Date.now() + 60_000, "second", source.id, secondDeposit);
});

afterEach(() => db.close());

it("replays only the recorded sponsor transfer after a lost acknowledgment", async () => {
  const request = { swapId: "first", source, depositAddress: deposit, minimumWei: 100_000n };
  rpc.sendRawTransaction.mockRejectedValueOnce(new Error("lost response"));
  await expect(createSatoraGasSponsor(db, key, 200_000n).ensureGas(request)).rejects.toThrow("lost response");
  await expect(createSatoraGasSponsor(db, key, 200_000n).ensureGas(request)).rejects.toThrow("awaiting confirmation");
  expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  expect(rpc.sendRawTransaction.mock.calls[1]).toEqual(rpc.sendRawTransaction.mock.calls[0]);
  const signed = rpc.sendRawTransaction.mock.calls[0][0].serializedTransaction;
  expect(parseTransaction(signed)).toMatchObject({ chainId: 1, nonce: 5, to: deposit, value: 120_000n });
});

it("reconciles a stuck sponsor nonce without sending another payment or exceeding the cap", async () => {
  const sponsor = createSatoraGasSponsor(db, key, 200_000n);
  await expect(sponsor.ensureGas({ swapId: "first", source, depositAddress: deposit, minimumWei: 195_000n })).rejects.toThrow("limit");
  await expect(sponsor.ensureGas({ swapId: "first", source, depositAddress: deposit, minimumWei: 100_000n })).rejects.toThrow("awaiting");
  db.prepare("UPDATE satora_orders SET expires_at = 1000 WHERE swap_id = 'first'").run();
  await expect(sponsor.ensureGas({ swapId: "second", source, depositAddress: secondDeposit, minimumWei: 100_000n })).rejects.toThrow("nonce");
  expect(rpc.sendRawTransaction).toHaveBeenCalledTimes(2);
  expect(rpc.sendRawTransaction.mock.calls[1]).toEqual(rpc.sendRawTransaction.mock.calls[0]);
});
