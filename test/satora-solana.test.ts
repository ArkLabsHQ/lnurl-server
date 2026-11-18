import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, VersionedTransaction,
} from "@solana/web3.js";
import { CCTP_DOMAINS, SOLANA_TOKEN_MESSENGER_MINTER_V2, SOLANA_USDC_MINT, type Client } from "@satora/swap";
import { base58 } from "@scure/base";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrations.js";
import {
  createSatoraSolanaSponsor, fundSatoraSolana, satoraSolanaDepositAddress, signSatoraSolanaBurn, type SolanaFeeSponsor,
} from "../src/rails/satora-solana.js";
import type { SatoraIntent } from "../src/rails/satora-sdk.js";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const hub = "0x1111111111111111111111111111111111111111";
const owner = new PublicKey(satoraSolanaDepositAddress(mnemonic));
const mint = new PublicKey(SOLANA_USDC_MINT);
const token = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const associated = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const amount = 12_300_000n;
type Blockhash = Awaited<ReturnType<SolanaFeeSponsor["connection"]["getLatestBlockhash"]>>["blockhash"];

async function randomBlockhash(): Promise<Blockhash> {
  return base58.encode((await Keypair.generate()).publicKey.toBytes()) as Blockhash;
}

async function partiallySignedBurn(value = amount) {
  const event = await Keypair.generate();
  const [ata] = await PublicKey.findProgramAddress([owner.toBytes(), token.toBytes(), mint.toBytes()], associated);
  const keys = Array.from({ length: 18 }, (_, i) => ({ pubkey: new PublicKey(new Uint8Array(32).fill(i + 1)), isSigner: false, isWritable: false }));
  keys[0] = keys[1] = { pubkey: owner, isSigner: true, isWritable: true };
  keys[3] = { pubkey: ata, isSigner: false, isWritable: true };
  keys[10] = { pubkey: mint, isSigner: false, isWritable: true };
  keys[11] = { pubkey: event.publicKey, isSigner: true, isWritable: true };
  keys[14] = { pubkey: token, isSigner: false, isWritable: false };
  keys[15] = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };
  const data = Buffer.alloc(96);
  data.set([215, 60, 61, 46, 114, 55, 128, 176]);
  data.writeBigUInt64LE(value, 8);
  data.writeUInt32LE(CCTP_DOMAINS.Arbitrum, 16);
  data.set(Buffer.from(hub.slice(2).padStart(64, "0"), "hex"), 20);
  data.set(Buffer.from(hub.slice(2).padStart(64, "0"), "hex"), 52);
  data.writeBigUInt64LE(1_000n, 84);
  data.writeUInt32LE(1000, 92);
  const recentBlockhash = await randomBlockhash();
  const tx = new Transaction({ feePayer: owner, recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    new TransactionInstruction({ programId: new PublicKey(SOLANA_TOKEN_MESSENGER_MINTER_V2), keys, data }),
  );
  const compiled = tx.compileMessage();
  const partial = new VersionedTransaction(compiled);
  await partial.sign([event]);
  return partial.serialize();
}

describe("Satora Solana source", () => {
  it("derives a stable order owner and preserves the SDK's signed burn message", async () => {
    const input = await partiallySignedBurn();
    const candidate = await signSatoraSolanaBurn(input, mnemonic, amount, hub);
    const original = VersionedTransaction.deserialize(input);
    const signed = VersionedTransaction.deserialize(Buffer.from(candidate.raw, "base64"));
    expect(satoraSolanaDepositAddress(mnemonic)).toBe(owner.toBase58());
    expect(satoraSolanaDepositAddress("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong")).not.toBe(owner.toBase58());
    expect(signed.message.serialize()).toEqual(original.message.serialize());
    expect(signed.signatures[1]).toEqual(original.signatures[1]);
    expect(candidate.hash).toBe(base58.encode(signed.signatures[0]));
    expect(await Transaction.from(Buffer.from(candidate.raw, "base64")).verifySignatures()).toBe(true);
  });

  it("refuses any burn with a different amount or Arbitrum owner", async () => {
    await expect(signSatoraSolanaBurn(await partiallySignedBurn(amount + 1n), mnemonic, amount, hub)).rejects.toThrow("authorized deposit");
    await expect(signSatoraSolanaBurn(await partiallySignedBurn(), mnemonic, amount, "0x2222222222222222222222222222222222222222"))
      .rejects.toThrow("unexpected recipient");
  });

  it("checkpoints the exact burn before broadcast and resumes settlement from its finalized signature", async () => {
    const data = Buffer.alloc(165);
    data.set(mint.toBytes(), 0);
    data.set(owner.toBytes(), 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    let stored: { cctpBurnTxid?: string } = {};
    let candidate: SatoraIntent["cctpBurn"];
    const beforeBurn = vi.fn(async (_hash, prepared) => { candidate = prepared; });
    const broadcast = vi.fn(async (bytes: Uint8Array) => {
      expect(candidate?.raw).toBe(Buffer.from(bytes).toString("base64"));
      throw new Error("lost transport acknowledgement");
    });
    const sponsor = {
      rpcUrl: "https://solana.invalid",
      verifyNetwork: vi.fn(async () => {}),
      ensureGas: vi.fn(async () => {}),
      connection: {
        getAccountInfo: vi.fn(async () => ({ data, owner: token })),
        getMinimumBalanceForRentExemption: vi.fn(async () => 2_000_000n),
        getLatestBlockhash: vi.fn(async () => ({ blockhash: "", lastValidBlockHeight: 100n })),
        sendRawTransaction: broadcast,
        getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "finalized", err: null }] })),
      },
    } as unknown as SolanaFeeSponsor;
    const client = {
      getEvmAddress: () => hub,
      fundSwapFromSolana: async (_id: string, signer: { signAndSendTransaction(bytes: Uint8Array): Promise<string> }) => {
        if (!stored.cctpBurnTxid) await signer.signAndSendTransaction(await partiallySignedBurn());
        return { cctp: { burnSignature: stored.cctpBurnTxid } };
      },
    } as unknown as Client;
    const intent = {
      mnemonic, swapId: "order", source: { id: "satora-usdcsolana" }, solanaSponsor: sponsor,
      storage: { get: async () => stored, store: async (value: typeof stored) => { stored = value; } },
    } as unknown as SatoraIntent;
    await expect(fundSatoraSolana({ client, intent, amount, beforeBurn })).rejects.toThrow("lost transport acknowledgement");
    expect(base58.decode(candidate!.hash)).toHaveLength(64);
    expect(stored.cctpBurnTxid).toBeUndefined();
    await expect(fundSatoraSolana({ client, intent: { ...intent, cctpBurn: candidate }, amount, beforeBurn })).resolves.toBe(candidate?.hash);
    expect(beforeBurn).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("rebroadcasts only the persisted sponsor payment when its acknowledgement is lost", async () => {
    const db = openDb(":memory:");
    try {
      runMigrations(db);
      db.prepare(`INSERT INTO satora_orders(id,verify_id,address_id,amount_sat,mnemonic,swap_id,deposit_address,
         payment_option,expires_at,active,next_poll_at,created_at)
         VALUES('o','v',1,1000,X'31','order',?,'satora-usdcsolana',2147483647,1,1,1)`).run(owner.toBase58());
      const sponsor = createSatoraSolanaSponsor(db, { rpcUrl: "https://solana.invalid", keySeed: "11".repeat(32), maxLamports: 12_000n });
      const { connection } = sponsor;
      vi.spyOn(connection, "getGenesisHash").mockResolvedValue("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" as Awaited<ReturnType<typeof connection.getGenesisHash>>);
      vi.spyOn(connection, "getBalance").mockResolvedValue(0n as Awaited<ReturnType<typeof connection.getBalance>>);
      const latest = vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
        blockhash: await randomBlockhash(), lastValidBlockHeight: 100n,
      });
      vi.spyOn(connection, "getFeeForMessage").mockResolvedValue({ value: 5_000n, context: { slot: 0n } } as Awaited<ReturnType<typeof connection.getFeeForMessage>>);
      vi.spyOn(connection, "getSignatureStatuses").mockResolvedValue({ value: [null], context: { slot: 0n } } as Awaited<ReturnType<typeof connection.getSignatureStatuses>>);
      vi.spyOn(connection, "getBlockHeight").mockResolvedValue(2n);
      const broadcast = vi.spyOn(connection, "sendRawTransaction").mockRejectedValue(new Error("lost transfer acknowledgement"));

      await expect(sponsor.ensureGas("order", "satora-usdcsolana", owner, 7_001n)).rejects.toThrow("allowed budget");
      expect(broadcast).not.toHaveBeenCalled();
      await expect(sponsor.ensureGas("order", "satora-usdcsolana", owner, 7_000n)).rejects.toThrow("lost transfer acknowledgement");
      await expect(sponsor.ensureGas("order", "satora-usdcsolana", owner, 7_000n)).rejects.toThrow("lost transfer acknowledgement");
      expect(latest).toHaveBeenCalledTimes(2);
      expect(broadcast.mock.calls[1][0]).toEqual(broadcast.mock.calls[0][0]);
      const row = db.prepare("SELECT raw_tx FROM satora_solana_topups WHERE swap_id = 'order'").get();
      expect(row?.raw_tx).toBe(Buffer.from(broadcast.mock.calls[0][0]).toString("base64"));
    } finally {
      db.close();
    }
  });
});
