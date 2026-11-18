import {
  ARKADE_HTLC_SCRIPT_VERSION_STRICT, Asset, checkFundingPayload, Client, InMemoryWalletStorage, PERMIT2_ADDRESS, StrictVhtlcScript, toChain,
  type EvmSigner, type EvmToArkadeSwapResponse, type FundingPayload, type StoredSwap, type SwapStatus, type SwapStorage,
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
  createWalletClient, encodeFunctionData, erc20Abi, getAddress, isHash,
  keccak256, parseEventLogs, TransactionReceiptNotFoundError, zeroAddress, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isSatoraAddress, SATORA_OPERATOR_URL, satoraSignerKey } from "./satora.js";
import { satoraSource, type SatoraSource } from "./satora-catalogue.js";
import { chainTxid } from "./fixedfloat/catalogue.js";
import { satoraEvmClient, satoraEvmChain, satoraEvmTransport } from "./satora-evm.js";
import {
  canRecoverUnburnedSatoraCctp, cctpEvmSource, fundSatoraCctp, hasFinalizedSatoraCctpRecovery, readSatoraCctpDeposit, recoverSatoraCctp,
  resumeSatoraCctp, type SatoraCctpBurn,
} from "./satora-cctp.js";
import {
  canRecoverUnburnedSatoraSolana, fundSatoraSolana, readSatoraSolanaDeposit, readSatoraSolanaReceipt, recoverSatoraSolanaCctp,
  recoverSatoraSolanaDeposit, satoraSolanaDepositAddress, type SolanaFeeSponsor,
} from "./satora-solana.js";

export type { SatoraCctpBurn } from "./satora-cctp.js";
export type { SolanaFeeSponsor } from "./satora-solana.js";

const SATORA_API = "https://api.satora.io/";
const QR_WINDOW_MS = 15 * 60_000;
const NON_POLYGON_FUNDING_WINDOW_MS = 25 * 60_000;
const arkadeProvider = new RestArkProvider(SATORA_OPERATOR_URL);
const arkadeIndexer = new RestIndexerProvider(SATORA_OPERATOR_URL);

export interface SatoraPayout {
  mnemonic: string;
  storage: SwapStorage;
  amountSat: number;
  destination: string;
  source: SatoraSource;
  ensureGas?: SatoraEnsureGas;
  solanaSponsor?: SolanaFeeSponsor;
}

export type SatoraEnsureGas = (input: {
  swapId: string;
  source: SatoraSource;
  depositAddress: string;
  minimumWei: bigint;
}) => Promise<void>;

export interface SatoraIntent extends SatoraPayout {
  swapId: string;
  cctpBurn?: SatoraCctpBurn;
  fundingSignal?: AbortSignal;
  retryBridgeRecovery?: true;
}

export interface SatoraSwapSnapshot {
  swapId: string;
  depositAddress: string;
  sourceAmount: string;
  status: SwapStatus;
  expiresAt: number;
  fundingExpiresAt?: number;
  fundingTxId?: string;
  claimTxId?: string;
  refundTxId?: string;
}

type BeforeSubmit = (txHash?: string, cctpBurn?: SatoraCctpBurn) => Promise<void>;
type LnurlStoredSwap = StoredSwap & { lnurlSatoraRelayFee?: string };

export function generateSatoraMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

function checkAmount(amountSat: number): void {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Expected a whole satoshi amount");
}

function tokenAmount(amount: string): bigint {
  if (!/^[1-9]\d{0,77}$/.test(amount)) throw new Error("Satora did not return a valid token amount");
  const value = BigInt(amount);
  if (value >= (1n << 256n)) throw new Error("Satora did not return a valid token amount");
  return value;
}

function evmSource(source: SatoraSource) {
  if (source.type !== "eip155") throw new Error("Unsupported Satora EVM network");
  return { chain: satoraEvmChain(source.chain), rpc: satoraEvmClient(source.chain), token: getAddress(source.token) };
}

function settlementSource(source: SatoraSource): SatoraSource {
  if (source.mode === "direct") return source;
  const arbitrumUsdc = satoraSource("satora-usdcarbitrum");
  if (!arbitrumUsdc) throw new Error("Missing Satora Arbitrum settlement asset");
  return arbitrumUsdc;
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
    .withBaseUrl(SATORA_API)
    .withMnemonic(payout.mnemonic)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(payout.storage)
    .withArkadeServerUrl(SATORA_OPERATOR_URL)
    .withLogLevel("silent")
    .build());
}

export async function quoteSatoraSwap(amountSat: number, source: SatoraSource): Promise<{ sourceAmount: string }> {
  checkAmount(amountSat);
  const client = await Client.builder().withBaseUrl(SATORA_API).withLogLevel("silent").build();
  const quote = await sdkCall("Satora could not provide a quote", () => client.getQuote({
    sourceChain: toChain(source.chain),
    sourceToken: source.token,
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

function evmHash(value: string | null | undefined): Hex | undefined {
  return value && isHash(value) ? value.toLowerCase() as Hex : undefined;
}

function sourceHash(source: SatoraSource, value: string | null | undefined): string | undefined {
  return source.type === "eip155" ? evmHash(value) : value ? chainTxid(source.type, value) : undefined;
}

function checkBridgeSource(swap: EvmToArkadeSwapResponse, source: SatoraSource): boolean {
  if (source.mode === "direct") return !swap.bridge_source_chain && !swap.bridge_source_token_address;
  if (source.type === "solana") return swap.bridge_source_chain === "Solana" && swap.bridge_source_token_address === source.token;
  const bridge = cctpEvmSource(source);
  return swap.bridge_source_chain === bridge.name && swap.bridge_source_token_address?.toLowerCase() === bridge.token.toLowerCase();
}

function snapshotOf(swap: EvmToArkadeSwapResponse, payout: SatoraPayout, ownerAddress: string, stored?: StoredSwap): SatoraSwapSnapshot {
  const asset = settlementSource(payout.source);
  const chain = satoraEvmChain(asset.chain);
  const token = getAddress(asset.token);
  const signer = satoraSignerKey(swap.arkade_server_pk);
  if (!isSatoraAddress(payout.destination, signer) || !isSatoraAddress(swap.btc_vhtlc_address, signer)) {
    throw new Error("Satora's Arkade operator does not match the payment destination");
  }
  if (swap.evm_chain_id !== chain.id || swap.source_token.chain !== asset.chain ||
      getAddress(swap.source_token.token_id) !== token || swap.source_token.decimals !== asset.decimals ||
      swap.target_token.chain !== Asset.BTC_ARKADE.chain || swap.target_token.token_id.toLowerCase() !== Asset.BTC_ARKADE.tokenId ||
      !swap.gasless || swap.target_arkade_address !== payout.destination || swap.target_amount !== String(payout.amountSat) ||
      getAddress(swap.client_evm_address) !== getAddress(ownerAddress) || swap.evm_htlc_kind !== "erc20" || !checkBridgeSource(swap, payout.source)) {
    throw new Error("Satora returned a different payment than requested");
  }
  const createdAt = Date.parse(swap.created_at);
  if (!Number.isFinite(createdAt)) throw new Error("Satora returned an invalid swap creation time");
  return {
    swapId: swap.id,
    depositAddress: payout.source.type === "solana" ? satoraSolanaDepositAddress(payout.mnemonic) : getAddress(ownerAddress),
    sourceAmount: tokenAmount(swap.source_amount).toString(),
    status: swap.status,
    expiresAt: createdAt + QR_WINDOW_MS,
    fundingExpiresAt: createdAt + (payout.source.chain === "137" ? QR_WINDOW_MS : NON_POLYGON_FUNDING_WINDOW_MS),
    fundingTxId: payout.source.mode === "cctp"
      ? sourceHash(payout.source, stored?.cctpBurnTxid)
      : evmHash(stored?.evmFundTxid) ?? evmHash(swap.evm_fund_txid),
    claimTxId: swap.btc_claim_txid ?? undefined,
    refundTxId: REFUNDED.has(swap.status) ? evmHash(swap.evm_claim_txid) : undefined,
  };
}

function relayFee(raw: unknown, amount: bigint): bigint {
  if (raw === "0" || raw === undefined) return 0n;
  if (typeof raw !== "string") throw new Error("Invalid Satora relay fee");
  const fee = tokenAmount(raw);
  if (fee >= amount) throw new Error("Invalid Satora relay fee");
  return fee;
}

async function checkDirectFunding(client: Client, snapshot: SatoraSwapSnapshot, payout: SatoraPayout): Promise<bigint> {
  return sdkCall("Satora could not verify the quoted deposit funding terms", async () => {
    const url = new URL(`swap/${encodeURIComponent(snapshot.swapId)}/swap-and-lock-calldata-permit2`, SATORA_API);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error("Satora funding preview unavailable");
    const payload = await response.json() as FundingPayload & {
      eip2612?: { supported?: boolean; already_approved?: boolean; domain_separator?: string; nonce?: number } | null;
    };
    const amount = tokenAmount(snapshot.sourceAmount);
    const fee = relayFee(payload.relay_fee, amount);
    const { hashLock, terms } = await client.getEvmFundingExpectation(snapshot.swapId);
    const checked = checkFundingPayload(terms, hashLock, payload, { maxSourceAmount: amount, maxRelayFee: fee });
    if (checked.sourceAmount !== amount) throw new Error("Satora's funding amount differs from the quote");
    const permit = payload.eip2612;
    const canPermit = permit?.supported === true && permit.already_approved === false &&
      /^(?:0x)?[0-9a-f]{64}$/i.test(permit.domain_separator ?? "") &&
      typeof permit.nonce === "number" && Number.isSafeInteger(permit.nonce) && permit.nonce >= 0;
    if (payout.source.gas === "provider" && !canPermit) {
      const { rpc, token } = evmSource(payout.source);
      const allowance = await rpc.readContract({
        address: token, abi: erc20Abi, functionName: "allowance",
        args: [getAddress(snapshot.depositAddress), PERMIT2_ADDRESS],
      });
      if (allowance < amount) throw new Error("Satora cannot relay an approval for this deposit");
    }
    return fee;
  });
}

export async function createSatoraSwap(payout: SatoraPayout & { maxSourceAmount?: string }): Promise<SatoraSwapSnapshot> {
  checkAmount(payout.amountSat);
  if (payout.source.gas === "native" && !(payout.source.type === "solana" ? payout.solanaSponsor : payout.ensureGas)) {
    throw new Error("Satora deposit gas sponsorship is unavailable");
  }
  const client = await paymentClient(payout);
  const { response } = await sdkCall("Could not create the Satora payment", () => client.createSwap({
    source: { chain: toChain(payout.source.chain), tokenId: payout.source.token },
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
  if (payout.source.mode === "direct") {
    const fee = await checkDirectFunding(client, snapshot, payout);
    const pinned: LnurlStoredSwap = { ...stored, lnurlSatoraRelayFee: String(fee) };
    await payout.storage.store(pinned);
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
  const original = snapshotOf(stored.response, intent, ownerAddress, stored);
  const swap = await sdkCall("Could not read the Satora payment", () => client.getSwap(intent.swapId));
  if (swap.id !== intent.swapId || swap.direction !== "evm_to_arkade") throw new Error("Satora returned a different swap");
  const snapshot = snapshotOf(swap, intent, ownerAddress, stored);
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

function tokenBalance(source: SatoraSource, address: string, blockTag: "latest" | "safe" | "finalized", contract?: Address): Promise<bigint> {
  const { rpc, token } = evmSource(source);
  return rpc.readContract({
    address: contract ?? token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
    blockTag,
  });
}

export function readSatoraDeposit(address: string, source: SatoraSource, solanaSponsor?: SolanaFeeSponsor): Promise<bigint> {
  if (source.type === "solana") {
    if (!solanaSponsor) throw new Error("Satora Solana sponsorship is unavailable");
    return readSatoraSolanaDeposit(address, solanaSponsor);
  }
  if (source.mode === "cctp") return readSatoraCctpDeposit(address, source);
  return tokenBalance(source, address, source.chain === "1" || source.chain === "42161" ? "safe" : "finalized");
}

async function checkDeposit(snapshot: SatoraSwapSnapshot, source: SatoraSource, amount: bigint, solanaSponsor?: SolanaFeeSponsor): Promise<void> {
  const balance = readSatoraDeposit(snapshot.depositAddress, source, solanaSponsor);
  const latest = source.type === "solana" ? balance : tokenBalance(source, snapshot.depositAddress, "latest");
  if ((await Promise.all([balance, latest])).some((value) => value !== amount)) {
    throw new Error("The confirmed deposit must match the exact token quote");
  }
  if ((snapshot.fundingExpiresAt ?? snapshot.expiresAt) <= Date.now()) throw new Error("This Satora swap is no longer accepting deposits");
}

async function approvePermit2(client: Client, intent: SatoraIntent, snapshot: SatoraSwapSnapshot, amount: bigint): Promise<void> {
  const { source, ensureGas, swapId } = intent;
  const { chain, rpc, token } = evmSource(source);
  const owner = getAddress(snapshot.depositAddress);
  const allowance = () => rpc.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [owner, PERMIT2_ADDRESS],
  });
  const approved = await allowance();
  if (approved === amount) return;
  if (!ensureGas || approved !== 0n) throw new Error("The exact Satora deposit approval is unavailable");
  const account = await depositorAccount(client, intent, owner);
  const tx = {
    account, to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2_ADDRESS, amount] }),
  };
  const [gas, fees] = await Promise.all([
    rpc.estimateGas({ ...tx, gasPrice: 0n }),
    rpc.estimateFeesPerGas(),
  ]);
  await ensureGas({ swapId, source, depositAddress: owner, minimumWei: gas * fees.maxFeePerGas });
  await checkDeposit(snapshot, source, amount);
  const nonce = await rpc.getTransactionCount({ address: owner, blockTag: "latest" });
  const current = await allowance();
  if (current === amount) return;
  if (current !== 0n) throw new Error("The Satora deposit approval changed");
  const wallet = createWalletClient({ account, chain, transport: satoraEvmTransport(source.chain) });
  const request = await wallet.prepareTransactionRequest({ ...tx, nonce, gas, ...fees });
  const serializedTransaction = await account.signTransaction(request);
  const hash = keccak256(serializedTransaction);
  const sent = await sdkCall("Could not confirm the Satora approval submission", () => wallet.sendRawTransaction({ serializedTransaction }));
  if (sent.toLowerCase() !== hash) throw new Error("The RPC returned a different Satora approval transaction");
  const receipt = await rpc.waitForTransactionReceipt({ hash, timeout: 25_000 });
  if (receipt.status !== "success" || await allowance() !== amount) throw new Error("The Satora deposit approval failed");
}

export async function fundSatoraSwap(intent: SatoraIntent, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot, stored } = await getOwnedSwap(intent);
  if (snapshot.fundingTxId) return snapshot.fundingTxId;
  if (snapshot.status !== "pending" || (snapshot.fundingExpiresAt ?? snapshot.expiresAt) <= Date.now()) {
    throw new Error("This Satora swap is no longer accepting deposits");
  }
  const amount = tokenAmount(snapshot.sourceAmount);
  await checkDeposit(snapshot, intent.source, amount, intent.solanaSponsor);
  if (intent.source.mode === "cctp") {
    if (!beforeSubmit) throw new Error("Satora bridge funding must reserve its burn before submission");
    const args = { client, intent, amount, beforeBurn: beforeSubmit };
    return intent.source.type === "solana" ? fundSatoraSolana(args) : fundSatoraCctp(args);
  }
  if (intent.source.gas === "native") {
    await approvePermit2(client, intent, snapshot, amount);
    await checkDeposit(snapshot, intent.source, amount);
  }
  const fee = relayFee((stored as LnurlStoredSwap).lnurlSatoraRelayFee, amount);
  await beforeSubmit?.();
  const { txHash } = await sdkCall("Could not confirm the Satora funding submission", () =>
    client.fundSwapGasless(intent.swapId, {
      funding: { maxSourceAmount: amount, maxRelayFee: fee },
    }));
  const hash = evmHash(txHash);
  if (!hash) throw new Error("Satora did not return a valid funding transaction");
  return hash;
}

export async function resumeSatoraFunding(intent: SatoraIntent): Promise<string | undefined> {
  if (intent.source.mode !== "cctp" || !intent.cctpBurn) return;
  const { client, snapshot } = await getOwnedSwap(intent);
  if (snapshot.status !== "pending") return snapshot.fundingTxId;
  const args = { client, intent, amount: tokenAmount(snapshot.sourceAmount) };
  return intent.source.type === "solana" ? fundSatoraSolana({
    ...args, beforeBurn: async () => { throw new Error("Satora must resume the saved Solana burn"); },
  }) : resumeSatoraCctp(args);
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
  if ((snapshot.status !== "serverfunded" && snapshot.status !== "clientredeeming") ||
      !claimWindowOpen(originalSwap.vhtlc_refund_locktime)) {
    throw new Error("Satora has no pending Arkade claim to finalize");
  }
  const { vhtlc, signer } = await sdkCall("Could not derive the original Satora lockup", () => claimTerms(stored, originalSwap));
  const script = vhtlc.pkScript;
  const { vtxos } = await arkadeIndexer.getVtxos({ scripts: [hex.encode(script)] });
  const accepted = vtxos.filter((vtxo) => vtxo.isSpent && vtxo.spentBy && vtxo.arkTxId === expectedTxId);
  const amount = accepted.reduce((sum, vtxo) => sum + BigInt(vtxo.value), 0n);
  if (amount < BigInt(intent.amountSat) && snapshot.status === "serverfunded") {
    return submitArkadeClaim(intent, stored, originalSwap, async (txid) => {
      if (txid !== expectedTxId) throw new Error("The Arkade claim no longer matches the reserved transaction");
    });
  }
  if (amount < BigInt(intent.amountSat)) throw new Error("The indexer has not observed the reserved Arkade claim");
  return sdkCall("Could not finalize the pending Satora Arkade claim", async () => {
    const tapLeafScript = vhtlc.claim();
    const message: Intent.GetPendingTxMessage = { type: "get-pending-tx", expire_at: Math.floor(Date.now() / 1000) + 120 };
    const proof = Intent.create(message, accepted.map((vtxo) => ({
      txid: hex.decode(vtxo.txid),
      index: vtxo.vout,
      witnessUtxo: { script, amount: BigInt(vtxo.value) },
      tapLeafScript: [tapLeafScript],
      sighashType: SigHash.ALL,
    })));
    accepted.forEach((_, i) => setArkPsbtField(proof, i + 1, VtxoTaprootTree, vhtlc.encode()));
    const signedProof = await signer.sign(proof);
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

async function finalizedReceipt(hash: string, source: SatoraSource) {
  const txHash = evmHash(hash);
  if (!txHash) throw new Error("Expected an EVM transaction hash");
  const { rpc } = evmSource(source);
  try {
    const receipt = await rpc.getTransactionReceipt({ hash: txHash });
    const head = await rpc.getBlock({ blockTag: "finalized" });
    return receipt.blockNumber <= head.number ? receipt : null;
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return null;
    throw new Error("Could not read the Satora transaction receipt");
  }
}

export async function readSatoraRecoveryReceipt(hash: string, source: SatoraSource, onSettlementChain = false, solanaSponsor?: SolanaFeeSponsor): Promise<"success" | "reverted" | null> {
  if (!onSettlementChain && source.type === "solana") {
    if (!solanaSponsor) throw new Error("Satora Solana sponsorship is unavailable");
    return readSatoraSolanaReceipt(hash, solanaSponsor);
  }
  return (await finalizedReceipt(hash, onSettlementChain ? settlementSource(source) : source))?.status ?? null;
}

async function hasFinalizedFunding(snapshot: SatoraSwapSnapshot, intent: SatoraIntent): Promise<boolean> {
  if (!snapshot.fundingTxId) return false;
  const { source, solanaSponsor } = intent;
  if (source.type === "solana") return await readSatoraRecoveryReceipt(snapshot.fundingTxId, source, false, solanaSponsor) === "success";
  const receipt = await finalizedReceipt(snapshot.fundingTxId, source);
  if (receipt?.status !== "success") return false;
  const { token } = evmSource(source);
  return parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .some((log) => getAddress(log.address) === token &&
      log.args.from === snapshot.depositAddress && log.args.to !== snapshot.depositAddress && log.args.value > 0n);
}

export class SatoraRecoveryGasError extends Error {
  constructor(chain: string, currency: string) {
    super(`The deposit address needs ${currency} on ${chain} for recovery fees`);
  }
}

async function depositorAccount(client: Client, intent: SatoraIntent, owner: string) {
  const { privateKey } = await sdkCall("Could not load the EVM deposit signer", () => client.getSwapDepositorKey(intent.swapId));
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address !== owner) throw new Error("The signer does not own the original EVM deposit address");
  return account;
}

async function depositSigner(client: Client, intent: SatoraIntent, owner: string, source: SatoraSource, beforeSubmit?: BeforeSubmit): Promise<EvmSigner> {
  const { chain, rpc } = evmSource(source);
  const account = await depositorAccount(client, intent, owner);
  const wallet = createWalletClient({ account, chain, transport: satoraEvmTransport(source.chain) });
  return {
    address: account.address,
    chainId: chain.id,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    sendTransaction: async ({ to, data, gas, value }) => {
      const tx = { account, to: getAddress(to), data: data as Hex, value };
      const [fees, balance] = await Promise.all([
        rpc.estimateFeesPerGas(),
        rpc.getBalance({ address: account.address }),
      ]);
      if (balance === 0n) throw new SatoraRecoveryGasError(chain.name, chain.nativeCurrency.symbol);
      const gasLimit = gas ?? await rpc.estimateGas(tx);
      if (balance < gasLimit * fees.maxFeePerGas + (value ?? 0n)) {
        throw new SatoraRecoveryGasError(chain.name, chain.nativeCurrency.symbol);
      }
      const request = await wallet.prepareTransactionRequest({ ...tx, gas: gasLimit, ...fees });
      const serializedTransaction = await account.signTransaction(request);
      const hash = keccak256(serializedTransaction);
      await beforeSubmit?.(hash);
      const sent = await sdkCall("Could not confirm the EVM recovery submission", () => wallet.sendRawTransaction({ serializedTransaction }));
      if (sent.toLowerCase() !== hash) throw new Error("The RPC returned a different recovery transaction hash");
      return hash;
    },
    estimateGas: ({ to, data, value }) => rpc.estimateGas({ account, to: getAddress(to), data: data as Hex, value }),
    waitForReceipt: async (hash) => {
      const receipt = await rpc.waitForTransactionReceipt({ hash: hash as Hex, timeout: 25_000 });
      return { status: receipt.status, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, logs: receipt.logs };
    },
    getTransaction: (hash) => rpc.getTransaction({ hash: hash as Hex }),
    call: async ({ to, data, value, blockNumber }) => {
      const result = await rpc.call({ account, to: getAddress(to), data: data as Hex, value, blockNumber });
      return result.data ?? "0x";
    },
  };
}

function recoveryDestination(refundAddress: string, depositAddress: string): Address {
  const destination = getAddress(refundAddress);
  if (destination === depositAddress || destination === zeroAddress) throw new Error("Use a separate EVM recovery address");
  return destination;
}

function transferToken(signer: EvmSigner, to: Address, token: Address, amount: bigint): Promise<string> {
  return signer.sendTransaction({
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  });
}

export async function recoverSatoraDeposit(intent: SatoraIntent, refundAddress: string, beforeSubmit?: BeforeSubmit): Promise<string> {
  const owned = await getOwnedSwap(intent);
  const { client, snapshot } = owned;
  const expiredUnfunded = snapshot.status === "expired" && (intent.cctpBurn
    ? await unburnedSource(intent, owned) : !snapshot.fundingTxId);
  const terminalFunded = snapshot.status === "serverredeemed" || REFUNDED.has(snapshot.status);
  if (!expiredUnfunded && !(terminalFunded && await hasFinalizedFunding(snapshot, intent))) {
    throw new Error("Satora has not reached a terminal state for deposit recovery");
  }
  if (intent.source.type === "solana") return recoverSatoraSolanaDeposit(intent, refundAddress, beforeSubmit);
  const destination = recoveryDestination(refundAddress, snapshot.depositAddress);
  const amount = await tokenBalance(intent.source, snapshot.depositAddress, "finalized");
  if (amount === 0n) throw new Error("There is no finalized deposit balance to recover");
  const signer = await depositSigner(client, intent, snapshot.depositAddress, intent.source, beforeSubmit);
  return transferToken(signer, destination, evmSource(intent.source).token, amount);
}

async function unburnedSource(intent: SatoraIntent, { client, snapshot, stored, swap }: Awaited<ReturnType<typeof getOwnedSwap>>): Promise<boolean> {
  if (intent.source.mode !== "cctp" || !intent.cctpBurn || snapshot.status !== "expired" ||
      stored.evmFundTxid || swap.evm_fund_txid) return false;
  return intent.source.type === "solana"
    ? canRecoverUnburnedSatoraSolana(intent)
    : canRecoverUnburnedSatoraCctp({ client, intent, amount: tokenAmount(snapshot.sourceAmount) });
}

export async function canRecoverUnburnedSatoraFunding(intent: SatoraIntent): Promise<boolean> {
  return unburnedSource(intent, await getOwnedSwap(intent));
}

async function recoverableBridge(intent: SatoraIntent) {
  if (intent.source.mode !== "cctp" || !intent.cctpBurn) throw new Error("No Satora bridge burn to recover");
  const owned = await getOwnedSwap(intent);
  const { snapshot, stored, swap } = owned;
  const burn = sourceHash(intent.source, intent.cctpBurn.hash);
  if (snapshot.status !== "expired" || stored.evmFundTxid || swap.evm_fund_txid ||
      !await hasFinalizedFunding({ ...snapshot, fundingTxId: burn }, intent)) {
    throw new Error("The Satora bridge must have a finalized burn and an expired swap before recovery");
  }
  return owned;
}

export async function recoverSatoraBridgedDeposit(intent: SatoraIntent, recipient: string, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot } = await recoverableBridge(intent);
  if (intent.source.type === "solana") return recoverSatoraSolanaCctp({ client, intent, recipient, beforeSubmit });
  return recoverSatoraCctp({ client, intent, recipient, amount: tokenAmount(snapshot.sourceAmount), beforeSubmit });
}

export async function hasFinalizedSatoraBridgeRecovery(intent: SatoraIntent, txHash: string, recipient: string): Promise<boolean> {
  const { client } = await recoverableBridge(intent);
  return hasFinalizedSatoraCctpRecovery(client, txHash, recipient);
}

export async function refundSatoraSwap(intent: SatoraIntent, beforeSubmit?: BeforeSubmit): Promise<string> {
  const { client, snapshot, swap } = await getOwnedSwap(intent);
  if (!REFUNDABLE.has(snapshot.status)) throw new Error("Satora has not reported a refundable EVM lock");
  if (swap.evm_refund_locktime * 1000 > Date.now()) {
    const { params } = await sdkCall("Could not read the Satora cooperative refund terms", () => client.buildCollabRefundEvmTypedData(intent.swapId));
    if (params.refundPath !== "coordinator") {
      const unlockAt = new Date(swap.evm_refund_locktime * 1000).toISOString();
      throw new Error(`This EVM lock can be refunded after ${unlockAt}`);
    }
    await beforeSubmit?.();
    const refund = await sdkCall("Could not confirm the Satora cooperative refund", () => client.collabRefundEvmSwap(intent.swapId));
    const hash = evmHash(refund.txHash);
    if (!hash) throw new Error("Satora did not return a valid refund transaction");
    return hash;
  }
  const signer = await depositSigner(client, intent, getAddress(client.getEvmAddress()), settlementSource(intent.source), beforeSubmit);
  const { txHash } = await sdkCall("Could not confirm the Satora timelock refund", () => client.refundEvmWithSigner(intent.swapId, signer));
  return txHash;
}

async function finalizedRefund(owned: Awaited<ReturnType<typeof getOwnedSwap>>, refundTxId: string, source: SatoraSource) {
  const { snapshot, stored, originalSwap } = owned;
  if (!REFUNDED.has(snapshot.status)) return undefined;
  const asset = settlementSource(source);
  const receipt = await finalizedReceipt(refundTxId, asset);
  if (receipt?.status !== "success") return undefined;
  const lockToken = stored.evmFundingTerms?.lockToken ?? originalSwap.evm_htlc_token ?? originalSwap.wbtc_address;
  const eligibleAssets = new Set([evmSource(asset).token, ...(lockToken ? [getAddress(lockToken)] : [])]);
  const refundContracts = new Set([getAddress(originalSwap.evm_htlc_address), getAddress(originalSwap.evm_coordinator_address)]);
  const owner = getAddress(owned.client.getEvmAddress());
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter((log) => log.args.to === owner && log.args.value > 0n &&
      eligibleAssets.has(getAddress(log.address)) && refundContracts.has(log.args.from));
  return transfers.length === 1 ? transfers[0] : undefined;
}

export async function hasFinalizedSatoraRefund(intent: SatoraIntent, refundTxId: string): Promise<boolean> {
  return Boolean(await finalizedRefund(await getOwnedSwap(intent), refundTxId, intent.source));
}

export async function withdrawSatoraRefund(intent: SatoraIntent, refundTxId: string, refundAddress: string, beforeSubmit?: BeforeSubmit): Promise<string> {
  const owned = await getOwnedSwap(intent);
  const { client } = owned;
  const owner = getAddress(client.getEvmAddress());
  const destination = recoveryDestination(refundAddress, owner);
  const transfer = await finalizedRefund(owned, refundTxId, intent.source);
  if (!transfer) throw new Error("Could not identify a finalized swap refund to the EVM deposit address");
  const token = getAddress(transfer.address);
  const amount = transfer.args.value;
  const asset = settlementSource(intent.source);
  if (await tokenBalance(asset, owner, "finalized", token) < amount) {
    throw new Error("The finalized balance no longer covers the HTLC refund");
  }
  const signer = await depositSigner(client, intent, owner, asset, beforeSubmit);
  return transferToken(signer, destination, token, amount);
}
