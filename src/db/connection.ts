import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Open a SQLite database and apply standard pragmas. */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
