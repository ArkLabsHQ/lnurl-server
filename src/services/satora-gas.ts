import { getAddress, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Db } from "../db/connection.js";
import type { SatoraSource } from "../rails/satora-catalogue.js";
import { satoraEvmChain, satoraEvmClient } from "../rails/satora-evm.js";

export interface SatoraGasRequest {
  swapId: string;
  source: SatoraSource;
  depositAddress: string;
  minimumWei: bigint;
}

interface Topup {
  chain: string;
  sender: string;
  recipient: string;
  hash: Hex;
  raw_tx: Hex;
}

export function createSatoraGasSponsor(db: Db, key: Hex, maxWei: bigint) {
  const account = privateKeyToAccount(key);
  const clients = new Map<string, ReturnType<typeof satoraEvmClient>>();
  const clientFor = ({ type, chain }: SatoraSource) => {
    if (type !== "eip155") throw new Error("Unsupported Satora gas funding chain");
    const existing = clients.get(chain);
    if (existing) return existing;
    const client = satoraEvmClient(chain);
    clients.set(chain, client);
    return client;
  };
  const get = db.prepare("SELECT chain, sender, recipient, hash, raw_tx FROM satora_gas_topups WHERE swap_id = ?");
  const byNonce = db.prepare("SELECT chain, sender, recipient, hash, raw_tx FROM satora_gas_topups WHERE chain = ? AND sender = ? AND nonce = ?");
  const reserve = db.prepare(`INSERT OR IGNORE INTO satora_gas_topups(swap_id, chain, sender, recipient, nonce, hash, raw_tx)
    SELECT ?, ?, ?, ?, ?, ?, ? FROM satora_orders
    WHERE swap_id = ? AND payment_option = ? AND deposit_address = ? COLLATE NOCASE
    AND active = 1 AND fund_started = 0 AND recovery_kind IS NULL AND COALESCE(funding_expires_at, expires_at) > ?`);
  const broadcast = async (client: ReturnType<typeof satoraEvmClient>, topup: Topup, chain: string) => {
    if (topup.chain !== chain || topup.sender !== account.address || keccak256(topup.raw_tx) !== topup.hash) {
      throw new Error("Stored Satora gas funding does not match this wallet and network");
    }
    await client.sendRawTransaction({ serializedTransaction: topup.raw_tx });
  };

  return {
    checkGas: async (source: SatoraSource): Promise<void> => {
      const client = clientFor(source);
      const [chainId, balance] = await Promise.all([client.getChainId(), client.getBalance({ address: account.address })]);
      if (String(chainId) !== source.chain || balance < maxWei) throw new Error("Satora gas payer is unavailable on this network");
      if (source.mode === "cctp") {
        await Promise.all([
          client.getBlock({ blockTag: "finalized" }),
          source.chain === "50" || client.getBlock({ blockTag: "safe" }),
        ]);
      }
    },
    ensureGas: async ({ swapId, source, depositAddress, minimumWei }: SatoraGasRequest): Promise<void> => {
      if (minimumWei <= 0n || minimumWei >= maxWei) throw new Error("Satora gas estimate exceeds the configured per-swap limit");
      const client = clientFor(source);
      const recipient = getAddress(depositAddress);
      const balance = await client.getBalance({ address: recipient });
      if (balance >= minimumWei) return;
      let topup = get.get(swapId) as unknown as Topup | undefined;
      if (!topup) {
        const deficit = minimumWei - balance;
        const [nonce, block, gas] = await Promise.all([
          client.getTransactionCount({ address: account.address, blockTag: "pending" }),
          client.getBlock(),
          client.estimateGas({ account: account.address, to: recipient, value: deficit }),
        ]);
        const fees = block.baseFeePerGas == null
          ? { type: "legacy" as const, gasPrice: await client.getGasPrice() }
          : { type: "eip1559" as const, ...await client.estimateFeesPerGas() };
        const maxFee = fees.type === "legacy" ? fees.gasPrice : fees.maxFeePerGas;
        const available = maxWei - maxFee * gas;
        if (deficit > available) throw new Error("Satora gas payment exceeds the configured per-swap limit");
        const target = deficit + minimumWei / 5n;
        const value = target < available ? target : available;
        const raw = await account.signTransaction({ chainId: satoraEvmChain(source.chain).id, nonce, to: recipient, value, gas, ...fees });
        const hash = keccak256(raw);
        reserve.run(swapId, source.chain, account.address, recipient, nonce, hash, raw, swapId, source.id, recipient, Date.now());
        topup = get.get(swapId) as unknown as Topup | undefined;
        if (!topup) {
          const pending = byNonce.get(source.chain, account.address, nonce) as unknown as Topup | undefined;
          if (pending) await broadcast(client, pending, source.chain);
          throw new Error("Satora gas funding is waiting for the next available nonce");
        }
      }
      if (topup.recipient !== recipient) throw new Error("Stored Satora gas funding does not match this order");
      await broadcast(client, topup, source.chain);
      throw new Error("Satora gas payment is awaiting confirmation");
    },
  };
}
