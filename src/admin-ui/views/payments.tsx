import { useEffect, useId, useState } from "react";
import { api, notConfigured, query, type AddressPage, type DiscoveryView, type Domain, type ReconcileRow, type ReconcileSweep, type SessionRow, type SettlementRow } from "../api.js";
import { ago, explorerLink, listText, num, plural, sats, sentence, unitAmount, when } from "../lib.js";
import { Alert, Badge, Copyable, Empty, Field, LoadError, Loading, Page, href, navigate, useAction, useConfirm, useDebounced, useLoad } from "../ui.js";

const OPTION_LABELS: Record<string, string> = { lightning: "Lightning", arkade: "Arkade", onchain: "Onchain" };
const optionLabel = (id: string) => OPTION_LABELS[id] ?? id;
const LIST_LIMIT = 200;
const SCOPED_LIMIT = 1000;
const SWEEP_MAX = 200; // RECONCILE_MAX in src/services/reconcile.ts

export function Settlements({ query: q }: { query: URLSearchParams }) {
  const filters = { settled: q.get("settled") ?? "", option: q.get("option") ?? "", address: q.get("address") ?? "", name: q.get("name") ?? "" };
  const setFilters = (patch: Partial<typeof filters>) => navigate("/settlements", { ...filters, ...patch });
  // One address's records come back oldest-updated first (SettlementStore.listByAddress), so take the
  // route's maximum and sort them like the unscoped list.
  const scopedLimit = filters.address ? SCOPED_LIMIT : undefined;
  const list = useLoad(
    () => api.get<SettlementRow[]>(`/settlements${query({ settled: filters.settled, option: filters.option, addressId: filters.address, limit: scopedLimit })}`),
    [filters.settled, filters.option, filters.address],
    5000,
  );
  // Only solver discovery knows the network; without it a destination stays copyable but unlinked.
  const network = useLoad(() => api.get<DiscoveryView>("/discovery").then((d) => d.network), []);
  const [sweeping, setSweeping] = useState(false);
  const rows = filters.address ? [...(list.data ?? [])].sort((a, b) => b.createdAt - a.createdAt) : list.data ?? [];
  const addressName = filters.name
    || rows.find((r) => r.address?.id === Number(filters.address))?.address?.lightningAddress
    || (filters.address ? `address #${filters.address}` : "");
  const options = [...new Set([...Object.keys(OPTION_LABELS), ...rows.map((r) => r.paymentOption), filters.option].filter(Boolean))];
  const withTokens = rows.some((r) => r.ffOrder);
  const filtered = Boolean(filters.settled || filters.option || filters.address);

  return (
    <Page title="Settlements" intro="Every payment a payer started on this server, and whether it settled."
      actions={<button type="button" className="btn" disabled={sweeping} onClick={() => setSweeping(true)}>Check for unrecorded payments</button>}>
      {sweeping && <Sweep onClose={() => setSweeping(false)} />}
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <select {...p} value={filters.settled} onChange={(e) => setFilters({ settled: e.target.value })}>
              <option value="">All</option>
              <option value="false">Pending</option>
              <option value="true">Settled</option>
            </select>
          )}
        </Field>
        <Field label="Rail">
          {(p) => (
            <select {...p} value={filters.option} onChange={(e) => setFilters({ option: e.target.value })}>
              <option value="">All</option>
              {options.map((o) => <option key={o} value={o}>{optionLabel(o)}</option>)}
            </select>
          )}
        </Field>
        <AddressFilter selected={filters.address} name={addressName}
          onPick={(a) => setFilters({ address: a ? String(a.id) : "", name: a?.name ?? "" })} />
        {list.updatedAt && (
          <span className="toolbar-note">
            Updates every 5 s
            <button type="button" className="btn btn-sm" onClick={() => void list.reload()}>Refresh</button>
          </span>
        )}
      </div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="payments" /> : !list.data ? null : rows.length === 0 ? (
        filtered
          ? <Empty title="No payments match these filters" action={<a className="btn" href="#/settlements">Clear filters</a>} />
          : <Empty title="No payments yet">A record appears as soon as a payer asks one of your addresses for an invoice or a destination.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th><th>Address</th><th>Rail</th><th className="num">Amount</th><th>Status</th><th>Destination</th><th>Reference</th>
                {withTokens && <th>Token order</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.paymentHash}>
                  <td className="nowrap"><span title={when(s.createdAt)}>{ago(s.createdAt)}</span></td>
                  <td>
                    {s.address
                      ? <a href={href("/settlements", { ...filters, address: s.address.id, name: s.address.lightningAddress })}>{s.address.lightningAddress}</a>
                      : <span className="muted" title="A session LNURL, or an address deleted since">—</span>}
                  </td>
                  <td>{optionLabel(s.paymentOption)}{s.swapId && <span className="sub">offline swap</span>}</td>
                  <td className="num nowrap">
                    {s.amountMsat != null ? <span title={`${num(s.amountMsat)} msat`}>{sats(s.amountMsat)}</span> : "—"}
                    {s.quote && <span className="sub">quoted {unitAmount(s.quote)}</span>}
                  </td>
                  <td>
                    {s.settled
                      ? <Badge tone="ok" title={s.settledAt ? `Settled ${when(s.settledAt)}` : undefined}>Settled</Badge>
                      : <Badge tone="info" title="Waiting for the payer">Pending</Badge>}
                    {s.settledAt && <span className="sub">{ago(s.settledAt)}</span>}
                    {s.hasPreimage && <span className="sub" title="The server holds this payment's preimage, so LUD-21 verify can prove it">preimage held</span>}
                  </td>
                  <td>
                    {/* A token deposit address is on another chain, so no Bitcoin explorer link. */}
                    {s.paymentDestination
                      ? <Destination value={s.paymentDestination} network={s.ffOrder ? undefined : network.data} />
                      : <><Copyable value={s.paymentHash} length={12} /><span className="sub">payment hash</span></>}
                  </td>
                  <td>{s.paymentReference ? <Copyable value={s.paymentReference} length={12} /> : <span className="muted">—</span>}</td>
                  {withTokens && (
                    <td>
                      {s.ffOrder ? (
                        <span title={s.ffOrder.ffCode}>
                          <code>{s.ffOrder.id}</code>{" "}
                          <Badge tone={s.ffOrder.status === "EMERGENCY" ? "bad" : "off"}>{s.ffOrder.status}</Badge>
                          {s.ffOrder.emergency && <span className="sub">{s.ffOrder.emergency.join(", ")}</span>}
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {filters.address
            ? rows.length >= SCOPED_LIMIT && <div className="table-foot">This address has over {num(SCOPED_LIMIT)} records; the most recently updated aren't shown.</div>
            : rows.length >= LIST_LIMIT && <div className="table-foot">Showing the latest {LIST_LIMIT}. Narrow the filters to reach older ones.</div>}
        </div>
      )}
    </Page>
  );
}

/** Type part of a username, pick a suggestion, and the list narrows to that address. */
function AddressFilter({ selected, name, onPick }: { selected: string; name: string; onPick: (a?: { id: number; name: string }) => void }) {
  const [text, setText] = useState(name);
  const [shown, setShown] = useState(name);
  if (name !== shown) {
    setShown(name);
    setText(name);
  }
  const domains = useLoad(() => api.get<Domain[]>("/domains"), []);
  const [user = "", host] = useDebounced(text.trim().toLowerCase(), 200).split("@");
  const domainId = host ? domains.data?.find((d) => d.domain === host)?.id : undefined;
  // The search is a substring match, newest first: a whole address searches its own domain deep enough
  // to find the exact name, while a partial one only fetches suggestions.
  const matches = useLoad(
    () => (user ? api.get<AddressPage>(`/addresses${query({ q: user, domainId, limit: domainId ? 1000 : 8 })}`).then((p) => p.addresses) : Promise.resolve([])),
    [user, domainId],
  );
  const options = (matches.data ?? []).filter((a) => a.domain).map((a) => ({ id: a.id, name: `${a.username}@${a.domain}` }));
  const hit = options.find((o) => o.name === text.trim().toLowerCase());
  // Also fires when suggestions arrive after the whole address was typed or pasted.
  useEffect(() => {
    if (hit && String(hit.id) !== selected) onPick(hit);
  }, [hit?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const listId = useId();
  return (
    <Field label="Address" className="grow">
      {(p) => (
        <div className="inline">
          <input {...p} type="search" list={listId} placeholder="Type a username" autoComplete="off" value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (!e.target.value && selected) onPick(undefined);
            }} />
          <datalist id={listId}>{options.slice(0, 8).map((o) => <option key={o.id} value={o.name} />)}</datalist>
          {selected && <button type="button" className="btn btn-sm" onClick={() => onPick(undefined)}>Show all</button>}
        </div>
      )}
    </Field>
  );
}

function Destination({ value, network }: { value: string; network?: string }) {
  const link = explorerLink(network, value);
  return (
    <span className="nowrap">
      <Copyable value={value} length={18} />
      {link && <>{" "}<a href={link} target="_blank" rel="noreferrer" title="Open in explorer" aria-label="Open in explorer">↗</a></>}
    </span>
  );
}

/** The "did anything go missing" sweep across every address with an Arkade identity. On demand only: it
 *  reads the indexer once per address, a support action rather than something to run beside a 5 s poll. */
function Sweep({ onClose }: { onClose: () => void }) {
  const result = useLoad(() => api.get<ReconcileSweep>("/reconcile"), []);
  const notable = result.data?.addresses.filter((a) => a.error || a.unattributed) ?? [];
  const missing = notable.filter((a) => a.unattributed).length;
  const failed = notable.filter((a) => a.error).length;
  const checked = result.data?.addresses.length ?? 0;
  return (
    <section className="panel">
      <div className="section-head">
        <h2>Unrecorded payments</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {result.loading && <p className="loading">Asking the indexer what reached each address. This can take a while…</p>}
      {result.error && (notConfigured(result.error)
        ? <Alert tone="off"><p>{sentence(result.error.message)}</p></Alert>
        : <LoadError error={result.error} retry={result.reload} />)}
      {result.data && (
        <>
          {result.data.unattributed > 0 && (
            <Alert tone="warn" title={`${plural(result.data.unattributed, "arrival")} across ${plural(missing, "address", "addresses")} ${result.data.unattributed === 1 ? "has" : "have"} no settlement record`}>
              <p>The money reached the user's own address; only the bookkeeping is missing. Usually it was paid after this server stopped watching the destination.</p>
            </Alert>
          )}
          {failed > 0 && (
            <Alert tone="warn" title={`${plural(failed, "address", "addresses")} couldn't be checked`}><p>The indexer's errors are listed below. Try again later.</p></Alert>
          )}
          {!result.data.unattributed && !failed && <Alert tone="ok" title={`Every arrival across ${plural(checked, "address", "addresses")} is accounted for.`} />}
          {checked >= SWEEP_MAX && <p className="muted small">Only the newest {SWEEP_MAX} addresses with an Arkade identity are checked.</p>}
        </>
      )}
      <div className="stack">
        {notable.map((row) => (
          <div key={row.addressId}>
            <p><strong>Address #{row.addressId}</strong>{row.arkadeAddress && <> <Copyable value={row.arkadeAddress} length={24} /></>}</p>
            <Arrivals row={row} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** What reached an address against what this server recorded. An unrecorded arrival is a bookkeeping gap,
 *  not lost money: the address is the user's own, and a covenant destination is still swept to it. */
export function Arrivals({ row }: { row: ReconcileRow }) {
  if (row.error) return <Alert tone="bad"><p>{sentence(row.error)}</p></Alert>;
  if (!row.arrivals?.length) return <p className="muted">No arrivals at this address.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Arrived</th><th className="num">Amount</th><th>Transaction</th><th>Recorded</th></tr></thead>
        <tbody>
          {row.arrivals.map((a) => (
            <tr key={`${a.txid}:${a.vout}`}>
              <td className="nowrap">{new Date(a.createdAt).toLocaleString()}</td>
              <td className="num nowrap">{num(a.value)} sats</td>
              <td><Copyable value={`${a.txid}:${a.vout}`} length={16} /></td>
              <td>{a.attributed ? <Badge tone="ok" title={a.paymentHash}>Recorded</Badge> : <Badge tone="warn">No record</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Sessions() {
  const list = useLoad(() => api.get<SessionRow[]>("/sessions"), [], 5000);
  const [filter, setFilter] = useState("");
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const addressText = (s: SessionRow, a: SessionRow["addresses"][number]) =>
    a.username === s.sessionId ? "nameless receiver" : `${a.username}@${a.domain ?? "?"}`;
  const term = filter.trim().toLowerCase();
  const rows = (list.data ?? []).filter((s) =>
    !term || [s.ip ?? "", s.sessionId, ...s.addresses.map((a) => addressText(s, a))].some((t) => t.toLowerCase().includes(term)));

  const disconnect = async (s: SessionRow) => {
    const names = s.addresses.map((a) => addressText(s, a));
    const ok = await confirm({
      title: "Disconnect this wallet?",
      body: <p>{names.length ? `${listText(names)} stop${names.length === 1 ? "s" : ""}` : "It stops"} receiving Lightning payments until the wallet reconnects.</p>,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (ok) await run(async () => { await api.post(`/sessions/${s.sessionId}/disconnect`, {}); await list.reload(); }, "Wallet disconnected");
  };

  return (
    <Page title="Sessions" intro="Wallets connected right now. A connected wallet answers invoice requests for its addresses itself.">
      <div className="toolbar">
        <Field label="Filter" className="grow">
          {(p) => <input {...p} type="search" placeholder="Address, IP or session id" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        </Field>
        {list.updatedAt && (
          <span className="toolbar-note">
            Updates every 5 s
            <button type="button" className="btn btn-sm" onClick={() => void list.reload()}>Refresh</button>
          </span>
        )}
      </div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="sessions" /> : !list.data ? null : rows.length === 0 ? (
        term
          ? <Empty title="No session matches that filter" />
          : <Empty title="No wallets connected">A wallet shows up here while it holds an LNURL session open.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Session</th><th>Addresses</th><th>Type</th><th>Connected</th><th>IP</th><th className="num">Invoices</th><th>Waiting for invoice</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.sessionId}>
                  <td><Copyable value={s.sessionId} length={10} /></td>
                  <td>
                    {s.addresses.length ? s.addresses.map((a) => (
                      <div key={`${a.username}@${a.domain}`} className="nowrap">
                        {addressText(s, a)}{a.status !== "active" && <> <Badge tone="off">{a.status}</Badge></>}
                      </div>
                    )) : <span className="muted">No address</span>}
                  </td>
                  <td>
                    {s.reusable
                      ? <Badge tone="off" title="The wallet brought its own token, so it can resume this session">Reusable</Badge>
                      : <Badge tone="off" title="The server issued the token; a reconnect starts a new session">One-time</Badge>}
                  </td>
                  <td className="nowrap"><span title={when(s.connectedAt)}>{ago(s.connectedAt)}</span></td>
                  <td><span className="mono">{s.ip ?? "—"}</span></td>
                  <td className="num">{num(s.invoicesIssued)}{s.lastInvoiceAt && <span className="sub">last {ago(s.lastInvoiceAt)}</span>}</td>
                  <td>
                    {s.pending ? (
                      <span title={s.pending.comment ? `Comment: ${s.pending.comment}` : undefined}>
                        {sats(s.pending.amountMsat)}<span className="sub">asked {ago(s.pending.since)}</span>
                      </span>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td className="actions"><button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void disconnect(s)}>Disconnect</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}
