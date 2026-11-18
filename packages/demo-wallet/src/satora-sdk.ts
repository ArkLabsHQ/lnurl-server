import { Asset, Client, IdbSwapStorage, InMemoryWalletStorage, type EvmSigner, type EvmToArkadeSwapResponse, type SwapStatus } from "@satora/swap";
import { ArkAddress, RestIndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

export const SATORA_POLYGON_USDC = getAddress(Asset.USDC_POLYGON.tokenId);
const QR_WINDOW_MS = 15 * 60_000;
const polygonClient = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 8_000, retryCount: 1 }) });
const swapStorage = new IdbSwapStorage();
const ARKADE_OPERATOR = "https://arkade.computer";
const arkadeIndexer = new RestIndexerProvider(ARKADE_OPERATOR);

interface SatoraPayout {
  mnemonic: string;
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
}

function checkAmount(amountSat: number): void {
  if (!Number.isSafeInteger(amountSat) || amountSat <= 0) throw new Error("Enter a whole satoshi amount");
}

function tokenAmount(amount: string): bigint {
  if (!/^[1-9]\d{0,77}$/.test(amount)) throw new Error("Satora did not return a valid USDC amount");
  return BigInt(amount);
}

function paymentClient(mnemonic: string): Promise<Client> {
  return Client.builder()
    .withMnemonic(mnemonic)
    .withSignerStorage(new InMemoryWalletStorage())
    .withSwapStorage(swapStorage)
    .withArkadeServerUrl(ARKADE_OPERATOR)
    .build();
}

export async function quoteSatoraSwap(amountSat: number): Promise<{ sourceAmount: string }> {
  checkAmount(amountSat);
  const client = await Client.builder().build();
  const quote = await client.getQuote({
    sourceChain: "137",
    sourceToken: SATORA_POLYGON_USDC,
    targetChain: "Arkade",
    targetToken: Asset.BTC_ARKADE.tokenId,
    targetAmount: amountSat,
  });
  if (quote.net_target_amount !== String(amountSat) || amountSat < quote.min_amount || amountSat > quote.max_amount) {
    throw new Error("Satora cannot quote that exact Arkade amount");
  }
  return { sourceAmount: tokenAmount(quote.net_source_amount).toString() };
}

function snapshotOf(swap: EvmToArkadeSwapResponse, payout: SatoraPayout, ownerAddress: string, storedFundingTx?: string): SatoraSwapSnapshot {
  const address = ArkAddress.decode(payout.destination);
  const lockup = ArkAddress.decode(swap.btc_vhtlc_address);
  const serverKey = /^(?:0[23])?([a-f0-9]{64})$/i.exec(swap.arkade_server_pk)?.[1]?.toLowerCase();
  if (address.hrp !== "ark" || address.version !== 0 || hex.encode(address.serverPubKey) !== serverKey ||
      lockup.hrp !== "ark" || lockup.version !== 0 || hex.encode(lockup.serverPubKey) !== serverKey) {
    throw new Error("Satora's Arkade operator does not match the payment destination");
  }
  if (swap.evm_chain_id !== polygon.id || swap.source_token.token_id.toLowerCase() !== SATORA_POLYGON_USDC.toLowerCase() ||
      swap.target_token.chain !== Asset.BTC_ARKADE.chain || swap.target_token.token_id.toLowerCase() !== Asset.BTC_ARKADE.tokenId ||
      !swap.gasless || swap.target_arkade_address !== payout.destination || swap.target_amount !== String(payout.amountSat) ||
      swap.client_evm_address.toLowerCase() !== ownerAddress.toLowerCase() || swap.bridge_source_chain) {
    throw new Error("Satora returned a different payment than requested");
  }
  const createdAt = Date.parse(swap.created_at);
  if (!Number.isFinite(createdAt)) throw new Error("Satora returned an invalid swap creation time");
  return {
    swapId: swap.id,
    depositAddress: getAddress(swap.client_evm_address),
    sourceAmount: tokenAmount(swap.source_amount).toString(),
    status: swap.status,
    expiresAt: createdAt + QR_WINDOW_MS,
    fundingTxId: storedFundingTx ?? swap.evm_fund_txid ?? undefined,
    claimTxId: swap.btc_claim_txid ?? undefined,
  };
}

export async function createSatoraSwap(payout: SatoraPayout & { maxSourceAmount?: string }): Promise<SatoraSwapSnapshot> {
  checkAmount(payout.amountSat);
  const client = await paymentClient(payout.mnemonic);
  const { response } = await client.createSwap({
    source: Asset.USDC_POLYGON,
    target: Asset.BTC_ARKADE,
    targetAddress: payout.destination,
    targetAmount: payout.amountSat,
    gasless: true,
  });
  if (!("target_arkade_address" in response) || !("evm_chain_id" in response)) {
    throw new Error("Satora returned an unexpected swap type");
  }
  const snapshot = snapshotOf(response, payout, client.getEvmAddress());
  if (snapshot.status !== "pending" || snapshot.expiresAt <= Date.now()) throw new Error("Satora payment is no longer open");
  const stored = await client.getStoredSwap(snapshot.swapId);
  if (stored?.targetAddress !== payout.destination || stored.evmFundingTerms?.sourceAmount !== snapshot.sourceAmount) {
    throw new Error("Satora did not save the original payment terms in this browser");
  }
  if (payout.maxSourceAmount !== undefined && tokenAmount(snapshot.sourceAmount) > tokenAmount(payout.maxSourceAmount)) {
    throw new Error("The Satora price changed. Request a new quote");
  }
  return snapshot;
}

async function getOwnedSwap(intent: SatoraIntent) {
  const client = await paymentClient(intent.mnemonic);
  const stored = await client.getStoredSwap(intent.swapId);
  if (!stored || stored.targetAddress !== intent.destination || stored.response.direction !== "evm_to_arkade") {
    throw new Error("The original Satora quote could not be found in this browser");
  }
  const ownerAddress = client.getEvmAddress();
  const original = snapshotOf(stored.response, intent, ownerAddress, stored.evmFundTxid);
  const swap = await client.getSwap(intent.swapId);
  if (swap.id !== intent.swapId || swap.direction !== "evm_to_arkade") throw new Error("Satora returned a different swap");
  const snapshot = snapshotOf(swap, intent, ownerAddress, original.fundingTxId);
  if (snapshot.sourceAmount !== original.sourceAmount || snapshot.expiresAt !== original.expiresAt ||
      swap.btc_vhtlc_address !== stored.response.btc_vhtlc_address) {
    throw new Error("Satora changed the existing payment quote");
  }
  return { client, snapshot, swap };
}

export async function readSatoraSwap(intent: SatoraIntent): Promise<SatoraSwapSnapshot> {
  return (await getOwnedSwap(intent)).snapshot;
}

export function readSatoraDeposit(address: string): Promise<bigint> {
  return polygonClient.readContract({
    address: SATORA_POLYGON_USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [getAddress(address)],
  });
}

export async function fundSatoraSwap(intent: SatoraIntent, beforeSubmit?: () => Promise<void>): Promise<string> {
  const { client, snapshot } = await getOwnedSwap(intent);
  if (snapshot.fundingTxId) return snapshot.fundingTxId;
  if (snapshot.status !== "pending") throw new Error("This Satora swap is no longer accepting deposits");
  const amount = tokenAmount(snapshot.sourceAmount);
  if (await readSatoraDeposit(snapshot.depositAddress) !== amount) {
    throw new Error("The Polygon deposit balance must match the exact USDC quote");
  }
  await beforeSubmit?.();
  return (await client.fundSwapGasless(intent.swapId, { funding: { maxSourceAmount: amount } })).txHash;
}

export async function claimSatoraSwap(intent: SatoraIntent, beforeSubmit?: () => Promise<void>): Promise<string> {
  const { client, snapshot, swap } = await getOwnedSwap(intent);
  if (snapshot.status === "clientredeeming") {
    const pending = await client.continueArkadeClaimSwap(intent.swapId);
    if (!pending.success || !pending.txId) throw new Error(pending.message);
    return pending.txId;
  }
  if (snapshot.claimTxId) return snapshot.claimTxId;
  if (snapshot.status !== "serverfunded") {
    throw new Error("Satora has not funded the Arkade leg yet");
  }
  const amounts = await client.amountsForSwap(intent.swapId);
  let claimable = BigInt(amounts.spendable);
  if (amounts.vtxoStatus === "recoverable" || amounts.vtxoStatus === "mixed") {
    const script = hex.encode(ArkAddress.decode(swap.btc_vhtlc_address).pkScript);
    const { vtxos } = await arkadeIndexer.getVtxos({ scripts: [script] });
    claimable = vtxos.reduce((sum, vtxo) => sum + (vtxo.isSpent ? 0n : BigInt(vtxo.value)), 0n);
  }
  if (claimable < BigInt(intent.amountSat)) throw new Error("The Arkade lockup does not cover the quoted amount");
  await beforeSubmit?.();
  const claimed = await client.claimArkade(intent.swapId, { destinationAddress: intent.destination, waitForVtxoMs: 0 });
  if (!claimed.success || !claimed.txId) throw new Error(claimed.message);
  return claimed.txId;
}

async function polygonSigner(client: Client, intent: SatoraIntent, beforeSubmit?: () => Promise<void>): Promise<EvmSigner> {
  const { privateKey } = await client.getSwapDepositorKey(intent.swapId);
  const account = privateKeyToAccount(privateKey as Hex);
  const wallet = createWalletClient({ account, chain: polygon, transport: http(undefined, { timeout: 8_000, retryCount: 1 }) });
  return {
    address: account.address,
    chainId: polygon.id,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    sendTransaction: async ({ to, data, gas, value }) => {
      const tx = { account, to: getAddress(to), data: data as Hex, value };
      const [gasLimit, fees, balance] = await Promise.all([
        gas ?? polygonClient.estimateGas(tx),
        polygonClient.estimateFeesPerGas(),
        polygonClient.getBalance({ address: account.address }),
      ]);
      if (balance < gasLimit * fees.maxFeePerGas + (value ?? 0n)) {
        throw new Error(`Add POL for network fees to ${account.address} before recovering funds`);
      }
      await beforeSubmit?.();
      return wallet.sendTransaction({ ...tx, gas: gasLimit, ...fees });
    },
    estimateGas: ({ to, data, value }) => polygonClient.estimateGas({ account, to: getAddress(to), data: data as Hex, value }),
    waitForReceipt: async (hash) => {
      const receipt = await polygonClient.waitForTransactionReceipt({ hash: hash as Hex });
      return { status: receipt.status, blockNumber: receipt.blockNumber, transactionHash: receipt.transactionHash, logs: receipt.logs };
    },
    getTransaction: (hash) => polygonClient.getTransaction({ hash: hash as Hex }),
    call: async ({ to, data, value, ...rest }) => {
      const result = await polygonClient.call({ account, to: getAddress(to), data: data as Hex, value, blockNumber: rest.blockNumber });
      return result.data ?? "0x";
    },
  };
}

export async function recoverSatoraDeposit(intent: SatoraIntent, refundAddress: string, beforeSubmit?: () => Promise<void>): Promise<string> {
  const { client, snapshot } = await getOwnedSwap(intent);
  if (snapshot.status !== "expired" || snapshot.fundingTxId) throw new Error("The Satora quote must expire before recovering a deposit that was not locked");
  const destination = getAddress(refundAddress);
  if (destination === snapshot.depositAddress || destination === "0x0000000000000000000000000000000000000000") {
    throw new Error("Enter your own separate Polygon recovery address");
  }
  const signer = await polygonSigner(client, intent, beforeSubmit);
  return (await client.recoverGaslessFunds(intent.swapId, signer, destination)).txHash;
}

const REFUNDABLE = new Set<SwapStatus>(["clientfundedserverrefunded", "clientinvalidfunded", "clientfundedtoolate", "serverwontfund"]);

export async function refundSatoraSwap(intent: SatoraIntent, beforeSubmit?: () => Promise<void>): Promise<string> {
  const { client, snapshot, swap } = await getOwnedSwap(intent);
  if (!REFUNDABLE.has(snapshot.status)) throw new Error("Satora has not reported a refundable EVM lock");
  if (swap.evm_refund_locktime * 1000 > Date.now()) {
    const { params } = await client.buildCollabRefundEvmTypedData(intent.swapId);
    if (params.refundPath !== "coordinator") {
      const unlockAt = new Date(swap.evm_refund_locktime * 1000).toISOString();
      throw new Error(`This Polygon lock can be refunded after ${unlockAt}`);
    }
    await beforeSubmit?.();
    const refund = await client.collabRefundEvmSwap(intent.swapId);
    if (!refund.txHash) throw new Error(refund.message || "Satora could not submit the refund");
    return refund.txHash;
  }
  const signer = await polygonSigner(client, intent, beforeSubmit);
  return (await client.refundEvmWithSigner(intent.swapId, signer)).txHash;
}

export async function exportSatoraRecoveryKey(intent: SatoraIntent): Promise<string> {
  const client = await paymentClient(intent.mnemonic);
  const stored = await client.getStoredSwap(intent.swapId);
  if (!stored || stored.response.direction !== "evm_to_arkade" || stored.targetAddress !== intent.destination) {
    throw new Error("The original Satora quote could not be found in this browser");
  }
  snapshotOf(stored.response, intent, client.getEvmAddress());
  return (await client.getSwapDepositorKey(intent.swapId)).privateKey;
}
