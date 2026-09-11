import type { Db } from "../connection.js";
import type { SolverCardRow } from "../types.js";

interface Row {
  id: number;
  label: string;
  network: string;
  card_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

const mapRow = (row: Row): SolverCardRow => ({
  id: row.id,
  label: row.label,
  network: row.network,
  cardJson: row.card_json,
  enabled: Boolean(row.enabled),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SolverCardsRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  list(): SolverCardRow[] {
    const rows = this.db.prepare("SELECT * FROM solver_cards ORDER BY id").all() as unknown as Row[];
    return rows.map(mapRow);
  }

  listEnabled(network: string): SolverCardRow[] {
    const rows = this.db.prepare("SELECT * FROM solver_cards WHERE network = ? AND enabled = 1 ORDER BY id").all(network) as unknown as Row[];
    return rows.map(mapRow);
  }

  get(id: number): SolverCardRow | undefined {
    const row = this.db.prepare("SELECT * FROM solver_cards WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  create(input: { label: string; network: string; cardJson: string }): SolverCardRow {
    const now = this.now();
    const result = this.db.prepare(
      "INSERT INTO solver_cards (label, network, card_json, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).run(input.label, input.network, input.cardJson, now, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  replace(id: number, input: { label: string; network: string; cardJson: string }): SolverCardRow | undefined {
    const result = this.db.prepare(
      "UPDATE solver_cards SET label = ?, network = ?, card_json = ?, updated_at = ? WHERE id = ?",
    ).run(input.label, input.network, input.cardJson, this.now(), id);
    return result.changes ? this.get(id) : undefined;
  }

  setEnabled(id: number, enabled: boolean): SolverCardRow | undefined {
    const result = this.db.prepare("UPDATE solver_cards SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, this.now(), id);
    return result.changes ? this.get(id) : undefined;
  }

  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM solver_cards WHERE id = ?").run(id).changes > 0;
  }
}
