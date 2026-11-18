import {
  CCTP_DOMAINS, cctpMetaForChainId, computeCctpFastFee, fetchCctpFee, finalityForChainId, getCctpViemChain,
  isCctpOnlySource, MESSAGE_TRANSMITTER_V2, TOKEN_MESSENGER_V2, type CctpChainName, type Client, type EvmSigner,
} from "@satora/swap";
import {
  createWalletClient, decodeFunctionData, erc20Abi, getAddress, isHex,
  keccak256, parseAbi, parseEventLogs, parseTransaction, recoverTransactionAddress, TransactionReceiptNotFoundError,
  type Address, type Hex, type TransactionSerialized, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SatoraIntent } from "./satora-sdk.js";
import type { SatoraSource } from "./satora-catalogue.js";
import { satoraEvmClient, satoraEvmTransport } from "./satora-evm.js";

export interface SatoraCctpBurn {
  hash: string;
  raw: string;
  lastValidBlockHeight?: number;
}

type StageBurn = (txId?: string, burn?: SatoraCctpBurn) => Promise<void>;

const HUB = cctpMetaForChainId(42161);
const MESSENGER = getAddress(TOKEN_MESSENGER_V2);
const BURN_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external",
]);
const NONCES_ABI = parseAbi(["function usedNonces(bytes32 nonce) view returns (uint256)"]);
const RPC_TIMEOUT_MS = 6_000;
const SOURCE_WAIT_MS = 9_000;
const ATTESTATION_WAIT_MS = 12_000;

export function cctpEvmSource(source: SatoraSource) {
  const id = Number(source.chain);
  const chain = getCctpViemChain(id);
  if (source.type !== "eip155" || source.mode !== "cctp" || source.unit !== "USDC" ||
      source.decimals !== 6 || !chain || !isCctpOnlySource(id)) {
    throw new Error("Unsupported Satora CCTP source");
  }
  const meta = cctpMetaForChainId(id);
  const token = getAddress(meta.usdc);
  if (getAddress(source.token) !== token) throw new Error("Unexpected CCTP source token");
  return { chain, token, name: meta.name, domain: meta.domain, hubToken: getAddress(HUB.usdc) };
}

function cctpRpc(source: SatoraSource) {
  return { ...cctpEvmSource(source), rpc: satoraEvmClient(source.chain) };
}

export async function readSatoraCctpDeposit(address: string, source: SatoraSource, blockTag: "safe" | "latest" | "finalized" = "safe"): Promise<bigint> {
  const { chain, token, rpc } = cctpRpc(source);
  const tag = chain.id === 50 && blockTag === "safe" ? "finalized" : blockTag;
  return rpc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(address)], blockTag: tag });
}

function parseBurn(tx: { to?: string | null; data?: string; value?: bigint }, source: SatoraSource, owner: Address, amount: bigint) {
  if (tx.to?.toLowerCase() !== MESSENGER.toLowerCase() || tx.value || !tx.data || !isHex(tx.data)) {
    throw new Error("Unexpected CCTP burn target");
  }
  const { token, chain } = cctpEvmSource(source);
  const { args } = decodeFunctionData({ abi: BURN_ABI, data: tx.data });
  const [input, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality] = args;
  const paddedOwner = owner.toLowerCase().slice(2).padStart(64, "0");
  if (input !== amount || domain !== HUB.domain || mintRecipient.toLowerCase() !== `0x${paddedOwner}` ||
      destinationCaller.toLowerCase() !== `0x${paddedOwner}` || getAddress(burnToken) !== token ||
      maxFee >= amount || finality !== finalityForChainId(chain.id)) {
    throw new Error("CCTP burn changed its payment terms");
  }
}

export async function validateSatoraCctpBurn(candidate: SatoraCctpBurn, source: SatoraSource, owner: Address, amount: bigint): Promise<{hash: Hex; raw: TransactionSerialized}> {
  if (!/^0x[0-9a-f]{64}$/.test(candidate.hash) || !isHex(candidate.raw) || keccak256(candidate.raw) !== candidate.hash) {
    throw new Error("Invalid saved CCTP burn identity");
  }
  const raw = candidate.raw as TransactionSerialized;
  const input = parseTransaction(raw);
  if (input.chainId !== Number(source.chain) || await recoverTransactionAddress({serializedTransaction: raw}) !== owner) {
    throw new Error("Saved CCTP burn changed its chain or owner");
  }
  parseBurn(input, source, owner, amount);
  return { hash: candidate.hash as Hex, raw };
}

async function cctpSigner(client: Client, intent: SatoraIntent, amount: bigint, reserve?: StageBurn) {
  const route = cctpRpc(intent.source);
  const { rpc, token, chain } = route;
  const { privateKey } = await client.getSwapDepositorKey(intent.swapId);
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== getAddress(client.getEvmAddress())) throw new Error("CCTP depositor key does not match the payment");
  const wallet = createWalletClient({ account, chain, transport: satoraEvmTransport(intent.source.chain) });
  const waitForReceipt: EvmSigner["waitForReceipt"] = async (input) => {
    const hash = input.toLowerCase() as Hex;
    const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: SOURCE_WAIT_MS });
    if (receipt.transactionHash !== hash) throw new Error("CCTP source transaction was replaced");
    return { ...receipt, logs: receipt.logs };
  };
  const signer: EvmSigner = {
    address: account.address,
    chainId: chain.id,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    getTransaction: (hash) => rpc.getTransaction({ hash: hash as Hex }),
    call: async ({ to, data, value, blockNumber }) => {
      const result = await rpc.call({ account, to: getAddress(to), data: data as Hex, value, blockNumber });
      return result.data ?? "0x";
    },
    waitForReceipt,
    sendTransaction: async ({ to, data, value }) => {
      intent.fundingSignal?.throwIfAborted();
      if (!reserve || value || !isHex(data)) throw new Error("New CCTP source transaction is disabled");
      const target = getAddress(to);
      const burn = target === MESSENGER;
      if (burn) {
        parseBurn({ to, data }, intent.source, account.address, amount);
        const balances = await Promise.all([
          readSatoraCctpDeposit(account.address, intent.source, "safe"),
          readSatoraCctpDeposit(account.address, intent.source, "latest"),
        ]);
        if (balances.some((balance) => balance !== amount)) throw new Error("CCTP deposit no longer matches its quote");
      } else {
        if (target !== token) throw new Error("Unexpected CCTP approval target");
        const approval = decodeFunctionData({ abi: erc20Abi, data });
        if (approval.functionName !== "approve" || getAddress(approval.args[0]) !== MESSENGER || approval.args[1] !== amount) {
          throw new Error("CCTP approval changed its payment terms");
        }
      }
      const [pending, nonce, fees] = await Promise.all([
        rpc.getTransactionCount({ address: account.address, blockTag: "pending" }),
        rpc.getTransactionCount({ address: account.address, blockTag: "latest" }),
        rpc.estimateFeesPerGas(),
      ]);
      if (pending !== nonce) throw new Error("Previous CCTP source transaction has not settled");
      const gasBudget = burn ? 500_000n : 650_000n;
      await intent.ensureGas!({
        swapId: intent.swapId, source: intent.source, depositAddress: account.address, minimumWei: gasBudget * fees.maxFeePerGas,
      });
      const gas = await rpc.estimateGas({ account, to: target, data });
      const gasWithMargin = (gas * 125n + 99n) / 100n;
      if (gasWithMargin > (burn ? 500_000n : 100_000n)) throw new Error("CCTP source gas exceeds its funding budget");
      const raw = await account.signTransaction({ chainId: chain.id, type: "eip1559", to: target, data, nonce, gas: gasWithMargin, ...fees, value: 0n });
      const hash = keccak256(raw);
      intent.fundingSignal?.throwIfAborted();
      if (burn) await reserve(hash, { hash, raw });
      const broadcast = await wallet.sendRawTransaction({ serializedTransaction: raw });
      if (broadcast.toLowerCase() !== hash) throw new Error("CCTP RPC returned a different transaction hash");
      return hash;
    },
  };
  return { route, account, signer, wallet };
}

interface CctpContext {
  client: Client;
  intent: SatoraIntent;
  amount: bigint;
}

function attestationSignal(intent: SatoraIntent): AbortSignal {
  const timeout = AbortSignal.timeout(ATTESTATION_WAIT_MS);
  return intent.fundingSignal ? AbortSignal.any([intent.fundingSignal, timeout]) : timeout;
}

function attestedNonce(message: string, sourceChain: CctpChainName, owner: Address): Hex {
  if (!isHex(message)) throw new Error("Malformed CCTP attestation");
  // CCTP v2 header fixes domains, replay nonce and destination caller independently of its body.
  const sourceDomain = Number.parseInt(message.slice(10, 18), 16);
  const destinationDomain = Number.parseInt(message.slice(18, 26), 16);
  const nonce = `0x${message.slice(26, 90)}` as Hex;
  const caller = message.slice(218, 282).toLowerCase();
  if (sourceDomain !== CCTP_DOMAINS[sourceChain] || destinationDomain !== HUB.domain ||
      caller !== owner.slice(2).toLowerCase().padStart(64, "0") || !/^0x[0-9a-f]{64}$/i.test(nonce)) {
    throw new Error("CCTP attestation changed the burn's destination");
  }
  return nonce;
}

export async function fundSatoraCctp({ client, intent, amount, beforeBurn }: CctpContext & { beforeBurn?: StageBurn }): Promise<string> {
  if (intent.cctpBurn || !beforeBurn || !intent.ensureGas) throw new Error("CCTP source funding is not available");
  const { signer, account, route } = await cctpSigner(client, intent, amount, beforeBurn);
  const balances = await Promise.all([
    readSatoraCctpDeposit(account.address, intent.source, "safe"),
    readSatoraCctpDeposit(account.address, intent.source, "latest"),
  ]);
  if (balances.some((balance) => balance !== amount)) throw new Error("CCTP deposit does not match its quote");
  const fee = await fetchCctpFee({
    sourceDomain: route.domain, destinationDomain: HUB.domain,
    finalityThreshold: finalityForChainId(route.chain.id), signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const maxFee = computeCctpFastFee(fee, amount);
  if (maxFee < 0n || maxFee >= amount) throw new Error("CCTP protocol fee exceeds the deposit");
  const signal = attestationSignal(intent);
  const result = await client.fundSwap(intent.swapId, signer, {
    maxFee, funding: { maxSourceAmount: amount }, signal,
    onProgress: ({phase}) => { if (phase === "submitting") signal.throwIfAborted(); },
  });
  if (!result.cctp || !/^0x[0-9a-f]{64}$/i.test(result.cctp.burnTxHash)) throw new Error("Satora did not return a CCTP burn");
  return result.cctp.burnTxHash.toLowerCase();
}

async function getBurnReceipt(rpc: ReturnType<typeof satoraEvmClient>, hash: Hex) {
  try {
    return await rpc.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return undefined;
    throw error;
  }
}

export async function resumeSatoraCctp({ client, intent, amount }: CctpContext): Promise<string | undefined> {
  if (!intent.cctpBurn) return;
  const { account, signer, route, wallet } = await cctpSigner(client, intent, amount);
  const { hash, raw } = await validateSatoraCctpBurn(intent.cctpBurn, intent.source, account.address, amount);
  const receipt = await getBurnReceipt(route.rpc, hash);
  if (!receipt) {
    intent.fundingSignal?.throwIfAborted();
    await wallet.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined);
    return;
  }
  if (receipt.status !== "success" || receipt.transactionHash !== hash) throw new Error("The reserved CCTP burn has not succeeded");
  const signal = attestationSignal(intent);
  const { message } = await client.cctpInbound.waitForAttestation({ sourceChain: route.name, txHash: hash, signal });
  const nonce = attestedNonce(message, route.name, account.address);
  const consumed = await satoraEvmClient("42161").readContract({
    address: MESSAGE_TRANSMITTER_V2, abi: NONCES_ABI, functionName: "usedNonces", args: [nonce],
  });
  if (consumed !== 0n) return hash;
  const stored = await client.getStoredSwap(intent.swapId);
  if (!stored || (stored.cctpBurnTxid && stored.cctpBurnTxid !== hash)) throw new Error("CCTP burn does not match stored swap");
  if (!stored.cctpBurnTxid) await intent.storage.store({ ...stored, cctpBurnTxid: hash });
  signal.throwIfAborted();
  const result = await client.fundSwap(intent.swapId, signer, {
    funding: { maxSourceAmount: amount }, signal,
    onProgress: ({phase}) => { if (phase === "submitting") signal.throwIfAborted(); },
  });
  if (result.cctp?.burnTxHash !== hash) throw new Error("Satora returned a different CCTP burn reference");
  return hash;
}

export async function recoverSatoraCctp({ client, intent, amount, recipient, beforeSubmit }: CctpContext & {
  recipient: string;
  beforeSubmit?: StageBurn;
}): Promise<string> {
  if (!intent.cctpBurn) throw new Error("No authenticated CCTP burn is available for recovery");
  const { account, route } = await cctpSigner(client, intent, amount);
  const { hash } = await validateSatoraCctpBurn(intent.cctpBurn, intent.source, account.address, amount);
  const receipt = await getBurnReceipt(route.rpc, hash);
  if (receipt?.status !== "success") throw new Error("CCTP source burn has not been confirmed");
  return recoverConfirmedSatoraCctp({ client, intent, recipient, beforeSubmit, hash, sourceChain: route.name });
}

export async function canRecoverUnburnedSatoraCctp({ client, intent, amount }: CctpContext): Promise<boolean> {
  if (!intent.cctpBurn) return false;
  const { account, route } = await cctpSigner(client, intent, amount);
  const { hash } = await validateSatoraCctpBurn(intent.cctpBurn, intent.source, account.address, amount);
  const [receipt, finalized, balance] = await Promise.all([
    getBurnReceipt(route.rpc, hash), route.rpc.getBlock({ blockTag: "finalized" }),
    readSatoraCctpDeposit(account.address, intent.source, "finalized"),
  ]);
  return receipt?.status === "reverted" && receipt.transactionHash === hash && receipt.blockNumber <= finalized.number && balance > 0n;
}

export async function recoverConfirmedSatoraCctp({ client, intent, recipient, beforeSubmit, hash, sourceChain }: {
  client: Client;
  intent: CctpContext["intent"];
  recipient: string;
  beforeSubmit?: StageBurn;
  hash: string;
  sourceChain: CctpChainName;
}): Promise<string> {
  if (!beforeSubmit) throw new Error("CCTP recovery requires a durable reservation");
  const owner = getAddress(client.getEvmAddress());
  const destination = getAddress(recipient);
  if (destination === owner || destination === zeroAddress) throw new Error("Use a separate Arbitrum recovery address");
  const { message } = await client.cctpInbound.waitForAttestation({ sourceChain, txHash: hash, signal: attestationSignal(intent) });
  const nonce = attestedNonce(message, sourceChain, owner);
  if (intent.retryBridgeRecovery) {
    const rpc = satoraEvmClient("42161");
    const consumed = await rpc.readContract({
      address: MESSAGE_TRANSMITTER_V2, abi: NONCES_ABI, functionName: "usedNonces", args: [nonce],
    });
    if (consumed === 0n) throw new Error("CCTP recovery has not minted USDC on Arbitrum");
    const balances = await Promise.all((["finalized", "latest"] as const).map((blockTag) => rpc.readContract({
      address: getAddress(HUB.usdc), abi: erc20Abi, functionName: "balanceOf", args: [owner], blockTag,
    })));
    if (balances.some((balance) => balance === 0n)) throw new Error("No Arbitrum USDC remains for same-recipient recovery");
  }
  await beforeSubmit();
  const result = await client.recoverCctpInboundSwap(intent.swapId, destination, {
    burnTxHash: hash, signal: attestationSignal(intent),
  });
  if (!result.sweepTxHash || !/^0x[0-9a-f]{64}$/i.test(result.sweepTxHash)) throw new Error("Satora did not return the Arbitrum recovery transaction");
  return result.sweepTxHash.toLowerCase();
}

export async function hasFinalizedSatoraCctpRecovery(client: Client, txHash: string, recipient: string): Promise<boolean> {
  if (!/^0x[0-9a-f]{64}$/i.test(txHash)) return false;
  const hash = txHash.toLowerCase() as Hex;
  const hubRpc = satoraEvmClient("42161");
  const [receipt, finalized] = await Promise.all([
    getBurnReceipt(hubRpc, hash), hubRpc.getBlock({ blockTag: "finalized" }),
  ]);
  if (receipt?.status !== "success" || receipt.transactionHash !== hash || receipt.blockNumber > finalized.number) return false;
  const owner = getAddress(client.getEvmAddress());
  const destination = getAddress(recipient);
  if (owner === destination || destination === zeroAddress) return false;
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).some(({ address, args }) =>
    getAddress(address) === getAddress(HUB.usdc) && getAddress(args.from) === owner &&
    getAddress(args.to) === destination && args.value > 0n,
  );
}
