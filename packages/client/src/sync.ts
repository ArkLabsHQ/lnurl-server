import { LnurlError } from "./errors.js";
import type { LnurlClient } from "./index.js";
import type { PaymentActivity } from "./types.js";

/**
 * One synced payment row, keyed by server plus server-local identifier.
 * Identifiers are unique per server, not globally, so the key scopes them.
 */
export interface StoredPayment {
  /** `${baseUrl}|${identifier}` — identifiers are unique per server, not globally. */
  key: string;
  /** Server root the payment was synced from. */
  baseUrl: string;
  /** Domain serving the address, taken from the page source. */
  domain: string;
  /** Full `user@domain` address, taken from the page source. */
  lightningAddress: string;
  /** paymentHash for bolt11, verifyId for destination. */
  identifier: string;
  /** Which rail the payment arrived on. */
  kind: "bolt11" | "destination";
  /** Whether the payment has settled. */
  settled: boolean;
  /** Agreed amount in millisats, when recorded. */
  amountMsat: number | null;
  /** Creation timestamp in milliseconds. */
  createdAt: number;
  /** Settlement timestamp in milliseconds, null while pending. */
  settledAt: number | null;
  /** RFQ id when a bolt11 payment was an offline swap, null otherwise. */
  swapId: string | null;
  /** Arkade txid once observed on a destination payment, null otherwise. */
  paymentReference: string | null;
  /** Arkade txid that credited the owner's own address, on any rail — the one
   *  their wallet can match against its own transaction history. */
  payoutReference: string | null;
  /** Preimage once a bolt11 payment settled; null while pending and on the
   * destination rail, which has no invoice to prove. */
  preimage: string | null;
  /** The rail a destination payment settled on, e.g. `arkade`. Null on the
   * bolt11 rail, where `kind` already says which rail it was. */
  paymentOption: string | null;
  /** Per-payment covenant script when the server derived one, else null. The
   * attribution key for concurrent covenant payments, and what a consumer
   * verifying the payment on-chain has to match against. */
  covenantScript: string | null;
}

/**
 * The persistence the sync loop needs. The package ships no implementation:
 * IndexedDB does not exist in Node or React Native, so the consumer supplies
 * the store — exactly as it already supplies `fetchImpl`. `upsert` is a
 * primitive rather than read-then-write so a database-backed store can do it
 * in one statement instead of loading every record on every sync.
 */
export interface PaymentSyncStore {
  /** Insert or replace by `record.key`. MUST overwrite, never append. */
  upsert(records: StoredPayment[]): Promise<void>;
  /** Last good inclusive cursor for one address, undefined when never synced. */
  readWatermark(baseUrl: string, lightningAddress: string): Promise<number | undefined>;
  /** Persists the inclusive cursor after a page is upserted; it moves backwards. */
  writeWatermark(baseUrl: string, lightningAddress: string, since: number): Promise<void>;
}

/**
 * One address to sync: where it lives and whose payments to list.
 */
export interface PaymentSyncTarget {
  /** Server root serving the address. */
  baseUrl: string;
  /** Token owning the address; sent as the Bearer credential. */
  token: string;
  /** Username part of the address. */
  username: string;
  /** Domain part of the address. */
  domain: string;
}

const DEFAULT_SYNC_PAGE_LIMIT = 50;
const SYNC_MAX_ATTEMPTS = 3;
const SYNC_RETRY_DELAY_MS = 250;
// Rails nothing server-side watches: unsettled there is terminal, not late.
const NEVER_SETTLES = new Set(["onchain"]);

type SyncClient = Pick<LnurlClient, "listPayments">;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (error: unknown): boolean => {
  if (error instanceof LnurlError) return error.retryable;
  return (error as { retryable?: boolean } | null)?.retryable === true;
};

const toStored = (
  baseUrl: string,
  domain: string,
  lightningAddress: string,
  entry: PaymentActivity,
): StoredPayment => {
  const identifier = entry.kind === "bolt11" ? entry.paymentHash : entry.verifyId;
  return {
    key: `${baseUrl}|${identifier}`,
    baseUrl,
    domain,
    lightningAddress,
    identifier,
    kind: entry.kind,
    settled: entry.settled,
    amountMsat: entry.amountMsat,
    createdAt: entry.createdAt,
    settledAt: entry.settledAt,
    swapId: entry.kind === "bolt11" ? entry.swapId : null,
    paymentReference: entry.kind === "destination" ? entry.paymentReference : null,
    // Present on both shapes: every rail eventually credits the owner somewhere.
    payoutReference: entry.payoutReference ?? null,
    preimage: entry.kind === "bolt11" ? entry.preimage : null,
    paymentOption: entry.kind === "destination" ? entry.paymentOption : null,
    covenantScript: entry.kind === "destination" ? entry.covenantScript : null,
  };
};

const mayStillSettle = (row: StoredPayment): boolean =>
  !row.settled && (row.paymentOption === null || !NEVER_SETTLES.has(row.paymentOption));

/** Oldest row still worth re-reading, or `fallback` when none is. */
const resumeFrom = (tail: StoredPayment[], fallback: number): number => {
  let oldest = fallback;
  for (const row of tail) if (mayStillSettle(row) && row.createdAt < oldest) oldest = row.createdAt;
  return oldest;
};

const listWithBackoff = (
  client: SyncClient,
  token: string,
  username: string,
  domain: string,
  since: number | undefined,
  limit: number,
) => {
  const attempt = async (tries: number) => {
    try {
      return await client.listPayments(token, username, { domain, since, limit });
    } catch (error) {
      if (!isRetryable(error) || tries >= SYNC_MAX_ATTEMPTS) throw error;
      await wait(tries * SYNC_RETRY_DELAY_MS);
      return attempt(tries + 1);
    }
  };
  return attempt(1);
};

const syncTarget = async (
  target: PaymentSyncTarget,
  client: SyncClient,
  store: PaymentSyncStore,
  limit: number,
  onStored: (count: number) => void,
): Promise<void> => {
  const lightningAddress = `${target.username}@${target.domain}`;
  let since = await store.readWatermark(target.baseUrl, lightningAddress);
  // One page's worth: how far back the cursor may reach for a pending row.
  const tail: StoredPayment[] = [];
  for (;;) {
    const page = await listWithBackoff(client, target.token, target.username, target.domain, since, limit);
    const records = page.payments.map((entry) =>
      toStored(target.baseUrl, page.source.domain, page.source.lightningAddress, entry),
    );
    await store.upsert(records);
    // Reported per page rather than returned, so a target that fails later
    // still counts the rows it did store — `synced` must match the store.
    onStored(records.length);
    for (const record of records) tail.push(record);
    if (tail.length > limit) tail.splice(0, tail.length - limit);
    const previous = since;
    since = page.nextSince;
    await store.writeWatermark(target.baseUrl, lightningAddress, resumeFrom(tail, since));
    if (page.payments.length < limit) return;
    // The cursor is the last row's createdAt, so a full page that fails to
    // advance it would re-fetch itself forever. The page is already stored.
    if (previous !== undefined && since <= previous) {
      throw new LnurlError(
        `payment sync stalled for ${lightningAddress} at ${target.baseUrl}: ${limit} payments share ` +
          `createdAt ${since}, so the cursor cannot advance past them`,
      );
    }
  }
};

/**
 * Syncs payment activity for every target into the consumer-supplied store.
 *
 * Each target paginates while a page comes back full
 * (`payments.length === limit`); a short page ends that target. The watermark
 * is written only after a page is successfully upserted, so a target that fails
 * wholly keeps its old cursor. It holds the oldest row still waiting to settle,
 * not the newest `createdAt`, because `settled` mutates after a row is created;
 * it reaches one page back at most, so a row nothing will ever settle costs one
 * extra page per sync rather than re-paging the history. Pagination itself still
 * walks `nextSince` forward. `nextSince` is inclusive, so the boundary row is
 * deliberately re-fetched and the store's key-overwrite absorbs it — the loop
 * itself never dedupes. Only `LnurlError.retryable` (HTTP 429) is retried;
 * anything else is terminal. A full page that leaves the cursor where it was
 * fails that target instead of re-fetching itself forever. A failing target is
 * collected into `failures` and the loop continues with the next one; this
 * function never throws.
 *
 * `client` is a factory rather than a single client because a client is pinned
 * to one `baseUrl`, while targets may live on different servers. Sharing one
 * would send every target's bearer token to whichever server that client was
 * built for:
 *
 * ```ts
 * await syncPayments(targets, {
 *   client: (baseUrl) => createLnurlClient({ baseUrl }),
 *   store,
 * })
 * ```
 *
 * @param targets - Addresses to sync, each bound to its serving baseUrl.
 * @param opts - Builds the client for one server, the store to write to, and an optional page limit.
 * @returns `synced` counts every row upserted, including rows a target stored
 *          on earlier pages before failing on a later one — so it always
 *          matches what is in the store. Such a target also appears in
 *          `failures`, meaning a non-zero `synced` and a failure can coexist.
 */
export function syncPayments(
  targets: PaymentSyncTarget[],
  opts: {
    client: (baseUrl: string) => Pick<LnurlClient, "listPayments">;
    store: PaymentSyncStore;
    limit?: number;
  },
): Promise<{ synced: number; failures: { baseUrl: string; error: unknown }[] }> {
  const run = async (): Promise<{ synced: number; failures: { baseUrl: string; error: unknown }[] }> => {
    const limit = opts.limit ?? DEFAULT_SYNC_PAGE_LIMIT;
    let synced = 0;
    const failures: { baseUrl: string; error: unknown }[] = [];
    for (const target of targets) {
      try {
        await syncTarget(target, opts.client(target.baseUrl), opts.store, limit, (count) => {
          synced += count;
        });
      } catch (error) {
        failures.push({ baseUrl: target.baseUrl, error });
      }
    }
    return { synced, failures };
  };
  return run();
}
