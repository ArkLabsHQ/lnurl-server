import {
  ARKADE_HTLC_SCRIPT_VERSION_STRICT, Asset, Client, InMemoryWalletStorage, StrictVhtlcScript,
  type EvmSigner, type EvmToArkadeSwapResponse, type StoredSwap, type SwapStatus, type SwapStorage,
} from "@satora/swap";
import {
  ArkAddress, claimWithPreimageIdentity, CSVMultisigTapscript, Intent, RestArkProvider, RestIndexerProvider, SingleKey,
  signAndSubmitOffchainTx, setArkPsbtField, Transaction, VtxoTaprootTree,
} from "@arkade-os/sdk";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { SigHash } from "@scure/btc-signer";
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, getAddress, http, isHash,
  keccak256, parseEventLogs, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { isSatoraAddress, SATORA_OPERATOR_URL, satoraSignerKey } from "./satora.js";

export const SATORA_POLYGON_USDC = getAddress(Asset.USDC_POLYGON.tokenId);
const QR_WINDOW_MS = 15 * 60_000;
const polygonTransport = http(undefined, { timeout: 8_000, retryCount: 0 });
const polygonClient = createPublicClient({ chain: polygon, transport: polygonTransport });
const arkadeProvider = new RestArkProvider(SATORA_OPERATOR_URL);
const arkadeIndexer = new RestIndexerProvider(SATORA_OPERATOR_URL);

export interface SatoraPayout {
  mnemonic: string;
  storage: SwapStorage;
  amountSat: number;
  destination: string;
}

export interface SatoraIntent extends SatoraPayout {
  swapId: string;
}

export interface SatoraSwapSnapshot {
  swapId: string;
  depositAddress: string;
  sourceAmount: string;
  status: SwapStatus;
  expiresAt: number;
  fundingTxId?: string;
  claimTxId?: string;
  refundTxId?: string;
}

type BeforeSubmit = (txHash?: string) => Promise<void>;

export function generateSatoraMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

function checkAmount(amountSat: number): void {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Expected a whole satoshi amount");
}

function tokenAmount(amount: string): bigint {
  if (!/^[1-9]\d{0,77}$/.test(amount)) throw new Error("Satora did not return a valid USDC amount");
  const value = BigInt(amount);
  if (value >= (1n << 256n)) throw new Error("Satora did not return a valid USDC amount");
  return value;
}

async function sdkCall<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SatoraRecoveryGasError) throw error;
    throw new Error(message);
  }
}

function paymentClient(payout: SatoraPayout): Promise<Client> {
  return sdkCall("Could not initialize the Satora payment", () => Client.builder()
    .withMnemonic(payout.mnemonic)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(payout.storage)
    .withArkadeServerUrl(SATORA_OPERATOR_URL)
    .withLogLevel("silent")
    .build());
}

export async function quoteSatoraSwap(amountSat: number): Promise<{ sourceAmount: string }> {
  checkAmount(amountSat);
  const client = await Client.builder().withLogLevel("silent").build();
  const quote = await sdkCall("Satora could not provide a quote", () => client.getQuote({
    sourceChain: "137",
    sourceToken: SATORA_POLYGON_USDC,
    targetChain: "Arkade",
    targetToken: Asset.BTC_ARKADE.tokenId,
    targetAmount: amountSat,
  }));
  if (quote.net_target_amount !== String(amountSat) || amountSat < quote.min_amount || amountSat > quote.max_amount) {
    throw new Error("Satora cannot quote that exact Arkade amount");
  }
  return { sourceAmount: tokenAmount(quote.net_source_amount).toString() };
}

const REFUNDED = new Set<SwapStatus>(["clientrefunded", "clientrefundedserverfunded", "clientrefundedserverrefunded"]);
const REFUNDABLE = new Set<SwapStatus>(["clientfundedserverrefunded", "clientinvalidfunded", "clientfundedtoolate", "serverwontfund"]);

function polygonHash(value: string | null | undefined): Hex | undefined {
  return value && isHash(value) ? value.toLowerCase() as Hex : undefined;
}

function snapshotOf(swap: EvmToArkadeSwapResponse, payout: SatoraPayout, ownerAddress: string, storedFundingTx?: string): SatoraSwapSnapshot {
  const signer = satoraSignerKey(swap.arkade_server_pk);
  if (!isSatoraAddress(payout.destination, signer) || !isSatoraAddress(swap.btc_vhtlc_address, signer)) {
    throw new Error("Satora's Arkade operator does not match the payment destination");
  }
  if (swap.evm_chain_id !== polygon.id || swap.source_token.chain !== "137" || getAddress(swap.source_token.token_id) !== SATORA_POLYGON_USDC ||
      swap.target_token.chain !== Asset.BTC_ARKADE.chain || swap.target_token.token_id.toLowerCase() !== Asset.BTC_ARKADE.tokenId ||
      !swap.gasless || swap.target_arkade_address !== payout.destination || swap.target_amount !== String(payout.amountSat) ||
      getAddress(swap.client_evm_address) !== getAddress(ownerAddress) || swap.evm_htlc_kind !== "erc20" || swap.bridge_source_chain) {
    throw new Error("Satora returned a different payment than requested");
  }
  const createdAt = Date.parse(swap.created_at);
  if (!Number.isFinite(createdAt)) throw new Error("Satora returned an invalid swap creation time");
  return {
    swapId: swap.id,
    depositAddress: getAddress(ownerAddress),
    sourceAmount: tokenAmount(swap.source_amount).toString(),
    status: swap.status,
    expiresAt: createdAt + QR_WINDOW_MS,
    fundingTxId: polygonHash(storedFundingTx) ?? polygonHash(swap.evm_fund_txid),
    claimTxId: swap.btc_claim_txid ?? undefined,
    refundTxId: REFUNDED.has(swap.status) ? polygonHash(swap.evm_claim_txid) : undefined,
  };
}

export async function createSatoraSwap(payout: SatoraPayout & { maxSourceAmount?: string }): Promise<SatoraSwapSnapshot> {
  checkAmount(payout.amountSat);
  const client = await paymentClient(payout);
  const { response } = await sdkCall("Could not create the Satora payment", () => client.createSwap({
    source: Asset.USDC_POLYGON,
    target: Asset.BTC_ARKADE,
    targetAddress: payout.destination,
    targetAmount: payout.amountSat,
    gasless: true,
  }));
  if (!("target_arkade_address" in response) || !("evm_chain_id" in response)) {
    throw new Error("Satora returned an unexpected swap type");
  }
  const snapshot = snapshotOf(response, payout, client.getEvmAddress());
  if (snapshot.status !== "pending" || snapshot.expiresAt <= Date.now()) throw new Error("Satora payment is no longer open");
  const stored = await client.getStoredSwap(snapshot.swapId);
  if (stored?.targetAddress !== payout.destination || stored.evmFundingTerms?.sourceAmount !== snapshot.sourceAmount) {
    throw new Error("Could not persist the original Satora payment terms");
  }
  if (payout.maxSourceAmount !== undefined && tokenAmount(snapshot.sourceAmount) > tokenAmount(payout.maxSourceAmount)) {
    throw new Error("The Satora price changed. Request a new quote");
  }
  return snapshot;
}

async function getOwnedSwap(intent: SatoraIntent) {
  const client = await paymentClient(intent);
  const stored = await client.getStoredSwap(intent.swapId);
  if (!stored || stored.swapId !== intent.swapId || stored.targetAddress !== intent.destination ||
      stored.response.direction !== "evm_to_arkade") {
    throw new Error("Could not find the original Satora payment terms");
  }
  const ownerAddress = client.getEvmAddress();
  const original = snapshotOf(stored.response, intent, ownerAddress, stored.evmFundTxid);
  const swap = await sdkCall("Could not read the Satora payment", () => client.getSwap(intent.swapId));
  if (swap.id !== intent.swapId || swap.direction !== "evm_to_arkade") throw new Error("Satora returned a different swap");
  const snapshot = snapshotOf(swap, intent, ownerAddress, original.fundingTxId);
  const pin = stored.response;
  if (snapshot.sourceAmount !== original.sourceAmount || snapshot.expiresAt !== original.expiresAt ||
      swap.hash_lock !== pin.hash_lock || swap.btc_vhtlc_address !== pin.btc_vhtlc_address ||
      swap.evm_htlc_address !== pin.evm_htlc_address || swap.evm_coordinator_address !== pin.evm_coordinator_address ||
      swap.server_evm_address !== pin.server_evm_address || swap.evm_refund_locktime !== pin.evm_refund_locktime) {
    throw new Error("Satora changed the existing payment quote");
  }
  return { client, snapshot, swap, stored, originalSwap: pin };
}

export async function readSatoraSwap(intent: SatoraIntent): Promise<SatoraSwapSnapshot> {
  return (await getOwnedSwap(intent)).snapshot;
}

function tokenBalance(address: string, token: Address, blockTag: "latest" | "finalized"): Promise<bigint> {
  return polygonClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
    blockTag,
  });
}

export function readSatoraDeposit(address: string): Promise<bigint> {
  return tokenBalance(address, SATORA_POLYGON_USDC, "finalized");
}

export async function fundSatoraSwap(intent: SatoraIntent, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot } = await getOwnedSwap(intent);
  if (snapshot.fundingTxId) return snapshot.fundingTxId;
  if (snapshot.status !== "pending" || snapshot.expiresAt <= Date.now()) {
    throw new Error("This Satora swap is no longer accepting deposits");
  }
  const amount = tokenAmount(snapshot.sourceAmount);
  const balances = await Promise.all([readSatoraDeposit(snapshot.depositAddress), tokenBalance(snapshot.depositAddress, SATORA_POLYGON_USDC, "latest")]);
  if (balances.some((balance) => balance !== amount)) throw new Error("The finalized Polygon deposit must match the exact USDC quote");
  if (snapshot.expiresAt <= Date.now()) throw new Error("This Satora swap is no longer accepting deposits");
  await beforeSubmit?.();
  const { txHash } = await sdkCall("Could not confirm the Satora funding submission", () =>
    client.fundSwapGasless(intent.swapId, { funding: { maxSourceAmount: amount } }));
  const hash = polygonHash(txHash);
  if (!hash) throw new Error("Satora did not return a valid funding transaction");
  return hash;
}

function claimWindowOpen(locktime: number): boolean {
  return Number.isSafeInteger(locktime) && locktime >= 500_000_000 && locktime > Date.now() / 1000 + 30;
}

function claimKey(key: string): Uint8Array {
  const xonly = satoraSignerKey(key);
  if (!xonly) throw new Error("Invalid Arkade lockup key");
  return hex.decode(xonly);
}

async function claimTerms(stored: StoredSwap, swap: EvmToArkadeSwapResponse) {
  const preimage = hex.decode(stored.preimage);
  if (preimage.length !== 32 || hex.encode(sha256(preimage)) !== stored.preimageHash.toLowerCase() ||
      swap.arkade_htlc_script_version !== ARKADE_HTLC_SCRIPT_VERSION_STRICT) {
    throw new Error("Satora returned incompatible Arkade lockup terms");
  }
  const signer = SingleKey.fromHex(stored.secretKey);
  const receiver = await signer.xOnlyPublicKey();
  const server = claimKey(swap.arkade_server_pk);
  if (hex.encode(receiver) !== hex.encode(claimKey(stored.publicKey))) throw new Error("Invalid Satora claim signer");
  const seconds = (value: number) => ({ type: "seconds" as const, value: BigInt(value) });
  const vhtlc = new StrictVhtlcScript({
    sender: claimKey(swap.sender_pk),
    receiver,
    server,
    preimageHash: ripemd160(sha256(preimage)),
    refundLocktime: BigInt(swap.vhtlc_refund_locktime),
    unilateralClaimDelay: seconds(swap.unilateral_claim_delay),
    unilateralRefundDelay: seconds(swap.unilateral_refund_delay),
    unilateralRefundWithoutReceiverDelay: seconds(swap.unilateral_refund_without_receiver_delay),
  });
  if (vhtlc.address("ark", server).encode() !== swap.btc_vhtlc_address) throw new Error("Invalid Satora Arkade lockup script");
  return { vhtlc, signer: claimWithPreimageIdentity(signer, preimage), server };
}

async function submitArkadeClaim(intent: SatoraIntent, stored: StoredSwap, swap: EvmToArkadeSwapResponse, beforeSubmit?: BeforeSubmit): Promise<string> {
  if (!claimWindowOpen(swap.vhtlc_refund_locktime)) throw new Error("The Satora Arkade claim window is closed");
  const { vhtlc, signer, server } = await sdkCall("Could not derive the original Satora lockup", () => claimTerms(stored, swap));
  const script = hex.encode(vhtlc.pkScript);
  const [{ vtxos }, info] = await Promise.all([
    arkadeIndexer.getVtxos({ scripts: [script], spendableOnly: true }),
    arkadeProvider.getInfo(),
  ]);
  const amount = vtxos.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
  if (amount < BigInt(intent.amountSat)) throw new Error("The spendable Arkade lockup does not cover the quoted amount");
  const tapLeafScript = vhtlc.claim();
  const tapTree = vhtlc.encode();
  const provider = {
    submitTx: async (arkTx: string, checkpoints: string[]) => {
      const txid = Transaction.fromPSBT(base64.decode(arkTx)).id;
      if (!claimWindowOpen(swap.vhtlc_refund_locktime)) throw new Error("The Satora Arkade claim window is closed");
      await beforeSubmit?.(txid);
      return arkadeProvider.submitTx(arkTx, checkpoints);
    },
    finalizeTx: arkadeProvider.finalizeTx.bind(arkadeProvider),
  };
  const inputs = [...vtxos].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)
    .map(({ txid, vout, value }) => ({ txid, vout, value, tapLeafScript, tapTree }));
  return sdkCall("Could not confirm the Satora Arkade claim", () => signAndSubmitOffchainTx({
    identity: signer,
    provider,
    inputs,
    outputs: [{ script: ArkAddress.decode(intent.destination).pkScript, amount }],
    serverUnrollScript: CSVMultisigTapscript.decode(hex.decode(info.checkpointTapscript)),
    verifyServerSignatures: { serverPubkey: server },
  }));
}

export async function claimSatoraSwap(intent: SatoraIntent, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { snapshot, stored, originalSwap } = await getOwnedSwap(intent);
  if (snapshot.claimTxId) return snapshot.claimTxId;
  if (snapshot.status !== "serverfunded") throw new Error("Satora has not funded the Arkade leg");
  return submitArkadeClaim(intent, stored, originalSwap, beforeSubmit);
}

export async function continueSatoraClaim(intent: SatoraIntent, expectedTxId: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(expectedTxId)) throw new Error("Invalid Satora Arkade claim transaction");
  const { snapshot, stored, originalSwap } = await getOwnedSwap(intent);
  if (snapshot.claimTxId === expectedTxId) return expectedTxId;
  if (snapshot.status === "serverfunded") {
    return submitArkadeClaim(intent, stored, originalSwap, async (txid) => {
      if (txid !== expectedTxId) throw new Error("The Arkade claim no longer matches the reserved transaction");
    });
  }
  if (snapshot.status !== "clientredeeming" || !claimWindowOpen(originalSwap.vhtlc_refund_locktime)) {
    throw new Error("Satora has no pending Arkade claim to finalize");
  }
  return sdkCall("Could not finalize the pending Satora Arkade claim", async () => {
    const { vhtlc, signer } = await claimTerms(stored, originalSwap);
    const script = vhtlc.pkScript;
    const tapLeafScript = vhtlc.claim();
    const { vtxos } = await arkadeIndexer.getVtxos({ scripts: [hex.encode(script)] });
    if (vtxos.length === 0) throw new Error("The Arkade lockup has no known VTXOs");
    const message: Intent.GetPendingTxMessage = { type: "get-pending-tx", expire_at: Math.floor(Date.now() / 1000) + 120 };
    const proof = Intent.create(message, vtxos.map((vtxo) => ({
      txid: hex.decode(vtxo.txid),
      index: vtxo.vout,
      witnessUtxo: { script, amount: BigInt(vtxo.value) },
      tapLeafScript: [tapLeafScript],
      sighashType: SigHash.ALL,
    })));
    vtxos.forEach((_, i) => setArkPsbtField(proof, i + 1, VtxoTaprootTree, vhtlc.encode()));
    const signedProof = await signer.sign(proof, vtxos.map((_, i) => i + 1));
    const pending = (await arkadeProvider.getPendingTxs({ message, proof: base64.encode(signedProof.toPSBT()) }))
      .find((tx) => tx.arkTxid === expectedTxId);
    if (!pending) throw new Error("The reserved Arkade claim is not pending");
    const tx = Transaction.fromPSBT(base64.decode(pending.finalArkTx));
    const payout = hex.encode(ArkAddress.decode(intent.destination).pkScript);
    const paid = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i))
      .reduce((sum, output) => sum + (output.script && hex.encode(output.script) === payout ? (output.amount ?? 0n) : 0n), 0n);
    if (tx.id !== expectedTxId || paid < BigInt(intent.amountSat)) throw new Error("The pending Arkade claim changed its payout");
    const checkpointIds = new Set(Array.from({ length: tx.inputsLength }, (_, i) => {
      const input = tx.getInput(i);
      if (!input.txid || input.index !== 0) throw new Error("Invalid reserved Arkade claim input");
      return hex.encode(input.txid);
    }));
    const finalized = await Promise.all(pending.signedCheckpointTxs.map(async (psbt) => {
      const checkpoint = Transaction.fromPSBT(base64.decode(psbt));
      if (checkpoint.inputsLength !== 1 || !checkpointIds.delete(checkpoint.id)) {
        throw new Error("The pending Arkade checkpoint does not belong to the reserved claim");
      }
      const leaves = checkpoint.getInput(0).tapLeafScript;
      if (leaves?.length !== 1 || hex.encode(leaves[0][1]) !== hex.encode(tapLeafScript[1])) {
        throw new Error("The pending Arkade checkpoint changed its spend path");
      }
      return base64.encode((await signer.sign(checkpoint, [0])).toPSBT());
    }));
    if (checkpointIds.size) throw new Error("The reserved Arkade claim is missing checkpoints");
    await arkadeProvider.finalizeTx(expectedTxId, finalized);
    return expectedTxId;
  });
}

async function finalizedReceipt(hash: string) {
  const txHash = polygonHash(hash);
  if (!txHash) throw new Error("Expected a Polygon transaction hash");
  try {
    const receipt = await polygonClient.getTransactionReceipt({ hash: txHash });
    const head = await polygonClient.getBlock({ blockTag: "finalized" });
    return receipt.blockNumber <= head.number ? receipt : null;
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw new Error("Could not read the Polygon transaction receipt");
  }
}

export async function readSatoraRecoveryReceipt(hash: string): Promise<"success" | "reverted" | null> {
  return (await finalizedReceipt(hash))?.status ?? null;
}

async function hasFinalizedFunding(snapshot: SatoraSwapSnapshot): Promise<boolean> {
  if (!snapshot.fundingTxId) return false;
  const receipt = await finalizedReceipt(snapshot.fundingTxId);
  if (receipt?.status !== "success") return false;
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .some((log) => getAddress(log.address) === SATORA_POLYGON_USDC &&
      log.args.from === snapshot.depositAddress && log.args.to !== snapshot.depositAddress && log.args.value > 0n);
}

export class SatoraRecoveryGasError extends Error {
  constructor() {
    super("The Polygon deposit address needs POL for recovery fees");
  }
}

async function polygonSigner(client: Client, intent: SatoraIntent, owner: string, beforeSubmit?: BeforeSubmit): Promise<EvmSigner> {
  const { privateKey } = await sdkCall("Could not load the Polygon deposit signer", () => client.getSwapDepositorKey(intent.swapId));
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== owner) throw new Error("The signer does not own the original Polygon deposit address");
  const wallet = createWalletClient({ account, chain: polygon, transport: polygonTransport });
  return {
    address: account.address,
    chainId: polygon.id,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    sendTransaction: async ({ to, data, gas, value }) => {
      const tx = { account, to: getAddress(to), data: data as Hex, value };
      const [fees, balance] = await Promise.all([
        polygonClient.estimateFeesPerGas(),
        polygonClient.getBalance({ address: account.address }),
      ]);
      if (balance === 0n) throw new SatoraRecoveryGasError();
      const gasLimit = gas ?? await polygonClient.estimateGas(tx);
      if (balance < gasLimit * fees.maxFeePerGas + (value ?? 0n)) {
        throw new SatoraRecoveryGasError();
      }
      const request = await wallet.prepareTransactionRequest({ ...tx, gas: gasLimit, ...fees });
      const serializedTransaction = await account.signTransaction(request);
      const hash = keccak256(serializedTransaction);
      await beforeSubmit?.(hash);
      const sent = await sdkCall("Could not confirm the Polygon recovery submission", () => wallet.sendRawTransaction({ serializedTransaction }));
      if (sent.toLowerCase() !== hash) throw new Error("Polygon returned a different recovery transaction hash");
      return hash;
    },
    estimateGas: ({ to, data, value }) => polygonClient.estimateGas({ account, to: getAddress(to), data: data as Hex, value }),
    waitForReceipt: async (hash) => {
      const receipt = await polygonClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: 25_000 });
      return { status: receipt.status, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, logs: receipt.logs };
    },
    getTransaction: (hash) => polygonClient.getTransaction({ hash: hash as Hex }),
    call: async ({ to, data, value, blockNumber }) => {
      const result = await polygonClient.call({ account, to: getAddress(to), data: data as Hex, value, blockNumber });
      return result.data ?? "0x";
    },
  };
}

function recoveryDestination(refundAddress: string, depositAddress: string): Address {
  const destination = getAddress(refundAddress);
  if (destination === depositAddress || destination === zeroAddress) throw new Error("Use a separate Polygon recovery address");
  return destination;
}

function transferToken(signer: EvmSigner, to: Address, token: Address, amount: bigint): Promise<string> {
  return signer.sendTransaction({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  });
}

export async function recoverSatoraDeposit(intent: SatoraIntent, refundAddress: string, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot } = await getOwnedSwap(intent);
  const expiredUnfunded = snapshot.status === "expired" && !snapshot.fundingTxId;
  const terminalFunded = snapshot.status === "serverredeemed" || REFUNDED.has(snapshot.status);
  if (!expiredUnfunded && !(terminalFunded && await hasFinalizedFunding(snapshot))) {
    throw new Error("Satora has not reached a terminal state for deposit recovery");
  }
  const destination = recoveryDestination(refundAddress, snapshot.depositAddress);
  const amount = await readSatoraDeposit(snapshot.depositAddress);
  if (amount === 0n) throw new Error("There is no finalized Polygon USDC balance to recover");
  const signer = await polygonSigner(client, intent, snapshot.depositAddress, beforeSubmit);
  return transferToken(signer, destination, SATORA_POLYGON_USDC, amount);
}

export async function refundSatoraSwap(intent: SatoraIntent, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot, swap } = await getOwnedSwap(intent);
  if (!REFUNDABLE.has(snapshot.status)) throw new Error("Satora has not reported a refundable EVM lock");
  if (swap.evm_refund_locktime * 1000 > Date.now()) {
    const { params } = await sdkCall("Could not read the Satora cooperative refund terms", () => client.buildCollabRefundEvmTypedData(intent.swapId));
    if (params.refundPath !== "coordinator") {
      const unlockAt = new Date(swap.evm_refund_locktime * 1000).toISOString();
      throw new Error(`This Polygon lock can be refunded after ${unlockAt}`);
    }
    await beforeSubmit?.();
    const refund = await sdkCall("Could not confirm the Satora cooperative refund", () => client.collabRefundEvmSwap(intent.swapId));
    const hash = polygonHash(refund.txHash);
    if (!hash) throw new Error("Satora did not return a valid refund transaction");
    return hash;
  }
  const signer = await polygonSigner(client, intent, snapshot.depositAddress, beforeSubmit);
  const { txHash } = await sdkCall("Could not confirm the Satora timelock refund", () => client.refundEvmWithSigner(intent.swapId, signer));
  return txHash;
}

async function finalizedRefund(owned: Awaited<ReturnType<typeof getOwnedSwap>>, refundTxId: string) {
  const { snapshot, stored, originalSwap } = owned;
  if (!REFUNDED.has(snapshot.status)) return undefined;
  const receipt = await finalizedReceipt(refundTxId);
  if (receipt?.status !== "success") return undefined;
  const lockToken = stored.evmFundingTerms?.lockToken ?? originalSwap.evm_htlc_token ?? originalSwap.wbtc_address;
  const eligibleAssets = new Set([SATORA_POLYGON_USDC, ...(lockToken ? [getAddress(lockToken)] : [])]);
  const refundContracts = new Set([getAddress(originalSwap.evm_htlc_address), getAddress(originalSwap.evm_coordinator_address)]);
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter((log) => log.args.to === snapshot.depositAddress && log.args.value > 0n &&
      eligibleAssets.has(getAddress(log.address)) && refundContracts.has(log.args.from));
  return transfers.length === 1 ? transfers[0] : undefined;
}

export async function hasFinalizedSatoraRefund(intent: SatoraIntent, refundTxId: string): Promise<boolean> {
  return Boolean(await finalizedRefund(await getOwnedSwap(intent), refundTxId));
}

export async function withdrawSatoraRefund(intent: SatoraIntent, refundTxId: string, refundAddress: string, beforeSubmit?: BeforeSubmit): Promise<string> {
  const owned = await getOwnedSwap(intent);
  const { client, snapshot } = owned;
  const destination = recoveryDestination(refundAddress, snapshot.depositAddress);
  const transfer = await finalizedRefund(owned, refundTxId);
  if (!transfer) throw new Error("Could not identify a finalized swap refund to the Polygon deposit address");
  const token = getAddress(transfer.address);
  const amount = transfer.args.value;
  if (await tokenBalance(snapshot.depositAddress, token, "finalized") < amount) {
    throw new Error("The finalized Polygon balance no longer covers the HTLC refund");
  }
  const signer = await polygonSigner(client, intent, snapshot.depositAddress, beforeSubmit);
  return transferToken(signer, destination, token, amount);
}
