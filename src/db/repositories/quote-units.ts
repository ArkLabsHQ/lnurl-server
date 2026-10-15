import type { Db } from "../connection.js";
import type { PriceFeedUnit } from "../../price-feed.js";

interface Row {
  code: string;
  decimals: number;
  feed_url: string;
  price_path: string;
}

/** Quote units entered through the admin API. QUOTE_UNITS env units never land here. */
export class QuoteUnitsRepo {
  constructor(private db: Db, private now: () => number = Date.now) {}

  list(): PriceFeedUnit[] {
    const rows = this.db.prepare("SELECT code, decimals, feed_url, price_path FROM quote_units ORDER BY code").all() as unknown as Row[];
    return rows.map((r) => ({ code: r.code, decimals: r.decimals, feedUrl: r.feed_url, pricePath: r.price_path, source: "admin" }));
  }

  upsert(unit: PriceFeedUnit): void {
    const now = this.now();
    this.db.prepare(
      `INSERT INTO quote_units (code, decimals, feed_url, price_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET decimals = excluded.decimals, feed_url = excluded.feed_url, price_path = excluded.price_path, updated_at = excluded.updated_at`,
    ).run(unit.code, unit.decimals, unit.feedUrl, unit.pricePath, now, now);
  }

  delete(code: string): boolean {
    return this.db.prepare("DELETE FROM quote_units WHERE code = ?").run(code).changes > 0;
  }
}
