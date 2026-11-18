import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db/connection.js";
import { ConfigError } from "./errors.js";
import { createLogger } from "./logger.js";
import { configureSatoraEvmRpc } from "./rails/satora-evm.js";
import { createSatoraService, SatoraRecoveryError } from "./services/satora.js";

const USAGE = "usage: satora list | satora inspect <ref> | satora recover <ref> <refund-address> | satora reconcile <ref> <arbitrum-tx-hash>";

export async function runSatoraCommand(args: string[]): Promise<void> {
  const [command, ref, target] = args;
  if (!((command === "list" && args.length === 1)
    || (command === "inspect" && args.length === 2 && ref)
    || ((command === "recover" || command === "reconcile") && args.length === 3 && ref && target))) {
    throw new ConfigError(USAGE);
  }

  const { dbPath, tokenEncryptionKey, satoraEvmGas, satoraSolanaGas, satoraEvmRpcUrls } = loadConfig();
  if (!dbPath || !tokenEncryptionKey || !existsSync(dbPath)) {
    throw new ConfigError("Satora recovery requires the original file-backed DB_PATH and TOKEN_ENCRYPTION_KEY");
  }
  const db = openDb(dbPath);
  try {
    configureSatoraEvmRpc(satoraEvmRpcUrls);
    const gas = satoraEvmGas
      ? (await import("./services/satora-gas.js")).createSatoraGasSponsor(db, satoraEvmGas.key, satoraEvmGas.maxWei)
      : undefined;
    const solanaSponsor = satoraSolanaGas
      ? (await import("./rails/satora-solana.js")).createSatoraSolanaSponsor(db, satoraSolanaGas)
      : undefined;
    const satora = createSatoraService({ db, encryptionKey: tokenEncryptionKey, logger: createLogger(), ...gas, solanaSponsor });
    if (command === "list") {
      console.log(JSON.stringify(satora.listRecoveryOrders(), null, 2));
      return;
    }
    if (command === "inspect") {
      console.log(JSON.stringify(await satora.inspect(ref), null, 2));
      return;
    }
    if (command === "reconcile") {
      console.log(JSON.stringify(await satora.reconcileBridgeRecovery(ref, target), null, 2));
      return;
    }
    const [order] = satora.listRecoveryOrders(ref);
    if (!order) throw new SatoraRecoveryError("Satora order was not found");
    const result = await satora.recover(order.swapId, order.addressId, target);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err instanceof SatoraRecoveryError) throw new ConfigError(err.message);
    throw new ConfigError("Satora operation failed. Check the original database, encryption key and provider availability.");
  } finally {
    db.close();
  }
}
