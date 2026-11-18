import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDb } from "./db/connection.js";
import { ConfigError } from "./errors.js";
import { createLogger } from "./logger.js";
import { createSatoraService, SatoraRecoveryError } from "./services/satora.js";

const USAGE = "usage: satora list | satora inspect <verify-id-or-swap-id> | satora recover <verify-id-or-swap-id> <polygon-refund-address>";

export async function runSatoraCommand(args: string[]): Promise<void> {
  const [command, ref, refundAddress] = args;
  if (!((command === "list" && args.length === 1)
    || (command === "inspect" && args.length === 2 && ref)
    || (command === "recover" && args.length === 3 && ref && /^0x[0-9a-f]{40}$/i.test(refundAddress)))) {
    throw new ConfigError(USAGE);
  }

  const { dbPath, tokenEncryptionKey } = loadConfig();
  if (!dbPath || !tokenEncryptionKey || !existsSync(dbPath)) {
    throw new ConfigError("Satora recovery requires the original file-backed DB_PATH and TOKEN_ENCRYPTION_KEY");
  }
  const db = openDb(dbPath);
  try {
    const satora = createSatoraService({ db, encryptionKey: tokenEncryptionKey, logger: createLogger() });
    if (command === "list") {
      console.log(JSON.stringify(satora.listRecoveryOrders(), null, 2));
      return;
    }
    const order = await satora.inspect(ref);
    const result = command === "inspect" ? order : await satora.recover(order.swapId, order.addressId, refundAddress);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    if (err instanceof SatoraRecoveryError) throw new ConfigError(err.message);
    throw new ConfigError("Satora operation failed. Check the original database, encryption key and provider availability.");
  } finally {
    db.close();
  }
}
