// The SDK's contract repositories over our own SQLite handle. They create and own
// their `ark_*` tables, so nothing here goes through src/db/migrations.ts — the
// schema belongs to the SDK and moves with it.

import type { Db } from "./db/connection.js";

/** node:sqlite is synchronous; the SDK's executor is not. Awaiting a plain value
 *  is already correct, so these are `async` only to satisfy the interface. */
function executor(db: Db) {
  const bind = (params?: unknown[]) => (params ?? []).map((p) => (p === undefined ? null : p)) as never[];
  return {
    run: async (sql: string, params?: unknown[]): Promise<void> => {
      db.prepare(sql).run(...bind(params));
    },
    get: async <T>(sql: string, params?: unknown[]): Promise<T | undefined> =>
      db.prepare(sql).get(...bind(params)) as T | undefined,
    all: async <T>(sql: string, params?: unknown[]): Promise<T[]> => db.prepare(sql).all(...bind(params)) as T[],
  };
}

export async function sqliteContractStores(db: Db) {
  const { SQLiteContractRepository, SQLiteWalletRepository } = await import("@arkade-os/sdk/repositories/sqlite");
  const exec = executor(db);
  return { contractRepository: new SQLiteContractRepository(exec), walletRepository: new SQLiteWalletRepository(exec) };
}

/** No DB_PATH: the SDK's own in-memory pair, so the two modes differ only in storage. */
export async function memoryContractStores() {
  const { InMemoryContractRepository, InMemoryWalletRepository } = await import("@arkade-os/sdk");
  return { contractRepository: new InMemoryContractRepository(), walletRepository: new InMemoryWalletRepository() };
}
