import { createHmac } from "node:crypto";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction,
  TransactionInstruction, VersionedTransaction,
} from "@solana/web3.js";
import { CCTP_DOMAINS, SOLANA_TOKEN_MESSENGER_MINTER_V2, SOLANA_USDC_MINT, type Client } from "@satora/swap";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import type { Db } from "../db/connection.js";
import { recoverConfirmedSatoraCctp, type SatoraCctpBurn } from "./satora-cctp.js";
import type { SatoraIntent } from "./satora-sdk.js";

const mint = new PublicKey(SOLANA_USDC_MINT);
const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ataProgram = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const circleProgram = new PublicKey(SOLANA_TOKEN_MESSENGER_MINTER_V2);
const burnInstruction = Buffer.from([215, 60, 61, 46, 114, 55, 128, 176]);
const mainnetGenesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const tokenAccountSize = 165;
const priorityFeeMicroLamports = 10_000n;
const burnStageBudgetMs = 30_000;

function orderSeed(mnemonic: string): Buffer {
  return createHmac("sha256", mnemonicToSeedSync(mnemonic)).update("lnurl-server:satora-solana-deposit:v1").digest();
}

export function satoraSolanaDepositAddress(mnemonic: string): string {
  return base58.encode(ed25519.getPublicKey(orderSeed(mnemonic)));
}

async function associatedAccount(owner: PublicKey): Promise<PublicKey> {
  return (await PublicKey.findProgramAddress([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ataProgram))[0];
}

async function sourceTokens(rpc: Connection, owner: PublicKey, commitment: "finalized" | "confirmed"): Promise<bigint> {
  const account = await rpc.getAccountInfo(await associatedAccount(owner), commitment);
  if (!account) return 0n;
  const data = Buffer.from(account.data);
  if (!account.owner.equals(tokenProgram) || data.length !== tokenAccountSize ||
      !data.subarray(0, 32).equals(mint.toBytes()) ||
      !data.subarray(32, 64).equals(owner.toBytes()) || data[108] !== 1) {
    throw new Error("Solana USDC deposit account is invalid");
  }
  return data.readBigUInt64LE(64);
}

type FinalizedReceipt = "success" | "reverted" | null;

async function finalizedReceipt(rpc: Connection, signature: string): Promise<FinalizedReceipt> {
  const { value: [status] } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (status?.confirmationStatus !== "finalized") return null;
  return status.err ? "reverted" : "success";
}

export interface SolanaFeeSponsor {
  rpcUrl: string;
  connection: Connection;
  verifyNetwork(): Promise<void>;
  checkGas(): Promise<void>;
  ensureGas(swapId: string, optionId: string, owner: PublicKey, minimumLamports: bigint): Promise<void>;
}

interface Topup {
  sender: string;
  recipient: string;
  signature: string;
  raw_tx: string;
  last_valid_height: number;
}

export function createSatoraSolanaSponsor(db: Db, config: { rpcUrl: string; keySeed: string; maxLamports: bigint }): SolanaFeeSponsor {
  if (!/^[\da-f]{64}$/i.test(config.keySeed)) throw new Error("Invalid Solana sponsor seed");
  const seed = Buffer.from(config.keySeed, "hex");
  const publicKey = new PublicKey(ed25519.getPublicKey(seed));
  const connection = new Connection(config.rpcUrl, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8_000) }),
  });
  const sender = publicKey.toBase58();
  let genesis: string | undefined;
  const verifyNetwork = async () => {
    genesis ??= await connection.getGenesisHash();
    if (genesis !== mainnetGenesis) throw new Error("Satora Solana checkout requires a mainnet RPC");
  };
  const get = db.prepare("SELECT sender, recipient, signature, raw_tx, last_valid_height FROM satora_solana_topups WHERE swap_id = ?");
  const reserve = db.prepare(`INSERT OR IGNORE INTO satora_solana_topups(swap_id, sender, recipient, signature, raw_tx, last_valid_height)
    SELECT ?, ?, ?, ?, ?, ? FROM satora_orders
    WHERE swap_id = ? AND payment_option = ? AND deposit_address = ? AND active = 1 AND fund_started = 0 AND recovery_kind IS NULL`);
  return {
    rpcUrl: config.rpcUrl,
    connection,
    verifyNetwork,
    async checkGas() {
      await verifyNetwork();
      if (await connection.getBalance(publicKey, "finalized") < config.maxLamports) {
        throw new Error("Satora Solana sponsor balance is low");
      }
    },
    async ensureGas(swapId, optionId, owner, minimumLamports) {
      await verifyNetwork();
      const recipient = owner.toBase58();
      if (recipient === sender || minimumLamports <= 0n || minimumLamports >= config.maxLamports) {
        throw new Error("Satora Solana fee estimate exceeds its allowed budget");
      }
      const balance = await connection.getBalance(owner, "finalized");
      if (balance >= minimumLamports) return;
      let topup = get.get(swapId) as unknown as Topup | undefined;
      if (!topup) {
        const lamports = minimumLamports - balance;
        const latest = await connection.getLatestBlockhash("finalized");
        const transfer = new Transaction({ feePayer: publicKey, ...latest })
          .add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: owner, lamports }));
        const { value: fee } = await connection.getFeeForMessage(transfer.compileMessage(), "finalized");
        if (fee === null || lamports + fee > config.maxLamports) {
          throw new Error("Satora Solana fee estimate exceeds its allowed budget");
        }
        await transfer.sign(await Keypair.fromSeed(seed));
        const signature = base58.encode(transfer.signature!);
        const raw = Buffer.from(await transfer.serialize()).toString("base64");
        reserve.run(swapId, sender, recipient, signature, raw, latest.lastValidBlockHeight, swapId, optionId, recipient);
        topup = get.get(swapId) as unknown as Topup | undefined;
        if (!topup) throw new Error("Satora Solana gas payment has no eligible order");
      }
      const raw = Buffer.from(topup.raw_tx, "base64");
      const tx = Transaction.from(raw);
      const debit = SystemInstruction.decodeTransfer(tx.instructions[0]);
      if (topup.sender !== sender || topup.recipient !== recipient || !debit.fromPubkey.equals(publicKey) ||
          !debit.toPubkey.equals(owner) || tx.instructions.length !== 1 || !tx.signature ||
          base58.encode(tx.signature) !== topup.signature) {
        throw new Error("Stored Solana gas payment does not match the order");
      }
      const status = await finalizedReceipt(connection, topup.signature);
      if (status || await connection.getBlockHeight("finalized") > BigInt(topup.last_valid_height)) {
        throw new Error("Satora Solana gas payment could not provide the required balance");
      }
      await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 0n });
      throw new Error("Satora Solana gas payment is awaiting finality");
    },
  };
}

export async function readSatoraSolanaDeposit(address: string, sponsor: SolanaFeeSponsor): Promise<bigint> {
  await sponsor.verifyNetwork();
  return sourceTokens(sponsor.connection, new PublicKey(address), "finalized");
}

export async function readSatoraSolanaReceipt(signature: string, sponsor: SolanaFeeSponsor): Promise<FinalizedReceipt> {
  await sponsor.verifyNetwork();
  if (base58.decode(signature).length !== 64) throw new Error("Invalid Solana transaction signature");
  return finalizedReceipt(sponsor.connection, signature);
}

function candidateHash(tx: VersionedTransaction): string {
  return base58.encode(tx.signatures[0]);
}

function savedSolanaBurn(intent: SatoraIntent) {
  if (!intent.cctpBurn) throw new Error("No saved Solana burn");
  const { hash, raw, lastValidBlockHeight } = intent.cctpBurn;
  const serialized = Buffer.from(raw, "base64");
  const tx = VersionedTransaction.deserialize(serialized);
  if (candidateHash(tx) !== hash || tx.message.staticAccountKeys[0]?.toBase58() !== satoraSolanaDepositAddress(intent.mnemonic)) {
    throw new Error("Stored Solana burn does not match the original order");
  }
  return { hash, serialized, blockhash: tx.message.recentBlockhash, lastValidBlockHeight };
}

/** Verify the SDK's partially signed burn without recompiling its legacy message. */
export async function signSatoraSolanaBurn(raw: Uint8Array, mnemonic: string, amount: bigint, evmOwner: string): Promise<SatoraCctpBurn> {
  const owner = await Keypair.fromSeed(orderSeed(mnemonic));
  const tx = VersionedTransaction.deserialize(raw);
  const message = tx.message;
  const { instructions, feePayer } = Transaction.from(Buffer.from(raw));
  const [limit, fee, burn] = instructions;
  if (instructions.length !== 3) throw new Error("Satora Solana burn has unexpected instructions");
  const limitData = Buffer.from(limit.data);
  const feeData = Buffer.from(fee.data);
  const burnData = Buffer.from(burn.data);
  const account = (index: number) => burn.keys[index]?.pubkey;
  if (!/^0x[\da-f]{40}$/i.test(evmOwner) || message.version !== "legacy" || tx.signatures.length !== 2 ||
      !feePayer?.equals(owner.publicKey) ||
      !limit.programId.equals(ComputeBudgetProgram.programId) || !fee.programId.equals(ComputeBudgetProgram.programId) ||
      limit.keys.length !== 0 || fee.keys.length !== 0 || limitData.length !== 5 || feeData.length !== 9 ||
      limitData[0] !== 2 || limitData.readUInt32LE(1) !== 100_000 || feeData[0] !== 3 ||
      feeData.readBigUInt64LE(1) > priorityFeeMicroLamports || !burn.programId.equals(circleProgram) ||
      burn.keys.length !== 18 || !account(0)?.equals(owner.publicKey) || !account(1)?.equals(owner.publicKey) ||
      !account(3)?.equals(await associatedAccount(owner.publicKey)) || !account(10)?.equals(mint) ||
      !account(11)?.equals(message.staticAccountKeys[1]) || !account(14)?.equals(tokenProgram) ||
      !account(15)?.equals(SystemProgram.programId) || burnData.length !== 96 ||
      !burnData.subarray(0, 8).equals(burnInstruction) || burnData.readBigUInt64LE(8) !== amount ||
      burnData.readUInt32LE(16) !== CCTP_DOMAINS.Arbitrum || burnData.readBigUInt64LE(84) >= amount) {
    throw new Error("Satora Solana burn does not match the authorized deposit");
  }
  const destination = Buffer.from(evmOwner.slice(2).padStart(64, "0"), "hex");
  if (!burnData.subarray(20, 52).equals(destination) || !burnData.subarray(52, 84).equals(destination) ||
      !ed25519.verify(tx.signatures[1], message.serialize(), message.staticAccountKeys[1].toBytes())) {
    throw new Error("Satora Solana burn has an unexpected recipient or event signature");
  }
  await tx.sign([owner]);
  return { hash: candidateHash(tx), raw: Buffer.from(tx.serialize()).toString("base64") };
}

export async function fundSatoraSolana({
  client, intent, amount, beforeBurn,
}: {
  client: Client;
  intent: SatoraIntent;
  amount: bigint;
  beforeBurn: (hash: string, candidate: SatoraCctpBurn) => Promise<void>;
}): Promise<string> {
  const sponsor = intent.solanaSponsor;
  if (!sponsor) throw new Error("Satora Solana RPC and fee sponsorship are required");
  const budget = AbortSignal.timeout(burnStageBudgetMs);
  const signal = intent.fundingSignal ? AbortSignal.any([budget, intent.fundingSignal]) : budget;
  signal.throwIfAborted();
  await sponsor.verifyNetwork();
  const { connection, rpcUrl } = sponsor;
  const publicKey = satoraSolanaDepositAddress(intent.mnemonic);
  const owner = new PublicKey(publicKey);

  if (intent.cctpBurn) {
    const { hash, serialized, blockhash } = savedSolanaBurn(intent);
    const status = await finalizedReceipt(connection, hash);
    if (!status) {
      if ((await connection.isBlockhashValid(blockhash, { commitment: "confirmed" })).value) {
        await connection.sendRawTransaction(serialized, { preflightCommitment: "confirmed", maxRetries: 0n });
      }
      throw new Error("Satora Solana burn is awaiting finality");
    }
    if (status === "reverted") throw new Error("The Satora Solana burn failed on chain");
    const stored = await intent.storage.get(intent.swapId);
    if (!stored || (stored.cctpBurnTxid && stored.cctpBurnTxid !== hash)) throw new Error("Satora Solana burn state does not match");
    if (!stored.cctpBurnTxid) await intent.storage.store({ ...stored, cctpBurnTxid: hash });
  } else {
    const balances = await Promise.all([
      sourceTokens(connection, owner, "finalized"), sourceTokens(connection, owner, "confirmed"),
    ]);
    if (balances.some((balance) => balance !== amount)) throw new Error("Solana USDC balance does not match the quote");
    // Leave enough SOL for Circle's event account rent and both transaction signatures.
    const rent = await connection.getMinimumBalanceForRentExemption(1024, "finalized");
    await sponsor.ensureGas(intent.swapId, intent.source.id, owner, rent + 20_000n);
  }

  const result = await client.fundSwapFromSolana(intent.swapId, {
    publicKey,
    signAndSendTransaction: async (raw) => {
      if (intent.cctpBurn) throw new Error("Refusing to construct a second Solana burn");
      const candidate = await signSatoraSolanaBurn(raw, intent.mnemonic, amount, client.getEvmAddress());
      const blockhash = VersionedTransaction.deserialize(raw).message.recentBlockhash;
      const latest = await connection.getLatestBlockhash("confirmed");
      if (latest.blockhash === blockhash) candidate.lastValidBlockHeight = Number(latest.lastValidBlockHeight);
      signal.throwIfAborted();
      await beforeBurn(candidate.hash, candidate);
      const signature = await connection.sendRawTransaction(Buffer.from(candidate.raw, "base64"), {
        preflightCommitment: "confirmed", maxRetries: 0n,
      });
      if (signature !== candidate.hash) throw new Error("Solana RPC returned a different burn signature");
      return signature;
    },
  }, { rpcUrl, priorityFeeMicroLamports, signal, funding: { maxSourceAmount: amount } });
  return result.cctp.burnSignature;
}

export async function canRecoverUnburnedSatoraSolana(intent: SatoraIntent): Promise<boolean> {
  const sponsor = intent.solanaSponsor;
  if (!sponsor || !intent.cctpBurn) return false;
  await sponsor.verifyNetwork();
  const { connection } = sponsor;
  const { hash, blockhash, lastValidBlockHeight } = savedSolanaBurn(intent);
  const status = await finalizedReceipt(connection, hash);
  if (status === "success") return false;
  if (status !== "reverted") {
    if (lastValidBlockHeight === undefined || await connection.getBlockHeight("finalized") <= BigInt(lastValidBlockHeight)) return false;
    const { value: [seen] } = await connection.getSignatureStatuses([hash], { searchTransactionHistory: true });
    if (seen || (await connection.isBlockhashValid(blockhash, { commitment: "finalized" })).value) return false;
  }
  return await readSatoraSolanaDeposit(satoraSolanaDepositAddress(intent.mnemonic), sponsor) > 0n;
}

export async function recoverSatoraSolanaCctp({
  client, intent, recipient, beforeSubmit,
}: {
  client: Client;
  intent: SatoraIntent;
  recipient: string;
  beforeSubmit?: (hash?: string) => Promise<void>;
}): Promise<string> {
  const { hash } = savedSolanaBurn(intent);
  if (!intent.solanaSponsor || await readSatoraSolanaReceipt(hash, intent.solanaSponsor) !== "success") {
    throw new Error("The Solana burn has not finalized");
  }
  return recoverConfirmedSatoraCctp({ client, intent, recipient, beforeSubmit, hash, sourceChain: "Solana" });
}

export async function recoverSatoraSolanaDeposit(intent: SatoraIntent, recipient: string, beforeSubmit?: (hash?: string) => Promise<void>): Promise<string> {
  const sponsor = intent.solanaSponsor;
  if (!sponsor || (intent.cctpBurn && !(await canRecoverUnburnedSatoraSolana(intent)))) {
    throw new Error("Solana USDC recovery requires a positive unburned deposit");
  }
  await sponsor.verifyNetwork();
  const { connection } = sponsor;
  const owner = await Keypair.fromSeed(orderSeed(intent.mnemonic));
  const address = new PublicKey(recipient);
  if (!PublicKey.isOnCurve(address.toBytes()) || owner.publicKey.equals(address) || address.equals(SystemProgram.programId)) {
    throw new Error("Use a separate Solana wallet address for recovery");
  }
  const amount = await sourceTokens(connection, owner.publicKey, "finalized");
  if (amount === 0n) throw new Error("No finalized Solana USDC balance to recover");
  const rent = await connection.getMinimumBalanceForRentExemption(tokenAccountSize, "finalized");
  await sponsor.ensureGas(intent.swapId, intent.source.id, owner.publicKey, rent + 15_000n);
  const target = await associatedAccount(address);
  const latest = await connection.getLatestBlockhash("finalized");
  const data = Buffer.alloc(10);
  data[0] = 12; // SPL Token TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = 6;
  const payer = { pubkey: owner.publicKey, isWritable: true, isSigner: true };
  const ro = (pubkey: PublicKey) => ({ pubkey, isWritable: false, isSigner: false });
  const rw = (pubkey: PublicKey) => ({ ...ro(pubkey), isWritable: true });
  const transfer = new Transaction({ feePayer: owner.publicKey, ...latest }).add(
    new TransactionInstruction({ programId: ataProgram, data: Buffer.from([1]),
      keys: [payer, rw(target), ro(address), ro(mint), ro(SystemProgram.programId), ro(tokenProgram)] }),
    new TransactionInstruction({ programId: tokenProgram, data,
      keys: [rw(await associatedAccount(owner.publicKey)), ro(mint), rw(target), { ...payer, isWritable: false }] }),
  );
  await transfer.sign(owner);
  const signature = base58.encode(transfer.signature!);
  await beforeSubmit?.(signature);
  const sent = await connection.sendRawTransaction(await transfer.serialize(), { preflightCommitment: "confirmed", maxRetries: 0n });
  if (sent !== signature) throw new Error("Solana RPC returned a different recovery signature");
  return signature;
}
