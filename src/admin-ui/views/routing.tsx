import { useState } from "react";
import { ApiError, api, errMsg, notConfigured, type DiscoveryView, type SavedCard, type ServerRail, type SolverCardRow } from "../api.js";
import { ago, plural, sentence, when } from "../lib.js";
import { Alert, Badge, Dialog, Empty, Field, LoadError, Loading, Page, useAction, useConfirm, useLoad, useToast } from "../ui.js";

const railState = (r: ServerRail) =>
  r.ready ? <Badge tone="ok">Ready</Badge>
    : r.configured ? <Badge tone="warn">Unavailable</Badge>
    : <Badge tone="off" title="This process wasn't started with what the rail needs">Not configured</Badge>;

export function Rails() {
  const list = useLoad(() => api.get<{ rails: ServerRail[] }>("/rails").then((r) => r.rails), []);
  return (
    <Page title="Rails" intro={<>Every way this server can take a payment. To switch one off for a single address, open it under <a href="#/addresses">Addresses</a> and choose Manage.</>}
      actions={<button type="button" className="btn" onClick={() => void list.reload()}>Refresh</button>}>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="rails" /> : !list.data ? null : !list.data.length ? <Empty title="No rails reported" /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Rail</th><th>What it does</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap"><strong>{r.label}</strong></td>
                  <td className="small">{r.description}</td>
                  <td>{railState(r)}{r.reason && <span className="sub">{sentence(r.reason)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

export function Solvers() {
  const status = useLoad(() => api.get<DiscoveryView>("/discovery"), []);
  const cards = useLoad(() => api.get<SolverCardRow[]>("/solver-cards"), []);
  const [adding, setAdding] = useState(false);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const toast = useToast();
  const reload = async () => { await Promise.all([status.reload(), cards.reload()]); };
  const off = status.error && notConfigured(status.error);

  const toggle = async (row: SolverCardRow) => {
    let active = false;
    const done = await run(async () => {
      active = (await api.patch<SavedCard>(`/solver-cards/${row.id}`, { enabled: !row.enabled })).active;
      await reload();
    });
    if (!done) return;
    if (row.enabled) toast(`${row.label} disabled`);
    else if (active) toast(`${row.label} enabled; routing uses it now`);
    else toast(`${row.label} enabled, but none of its markets is routable yet`, "warn");
  };
  const remove = async (row: SolverCardRow) => {
    if (!await confirm({
      title: `Delete ${row.label}?`,
      body: <p>Routing stops using this card at once. Registry cards for the same solver are unaffected.</p>,
      confirmLabel: "Delete card",
      danger: true,
    })) return;
    await run(async () => { await api.del(`/solver-cards/${row.id}`); await reload(); }, `${row.label} deleted`);
  };

  return (
    <Page title="Solvers" intro="Solvers swap a payer's Lightning payment into Arkade while the receiving wallet is offline."
      actions={!off && (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { await api.post("/discovery/refresh", {}); await reload(); }, "Routing refreshed")}>Refresh routing</button>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Add solver card</button>
        </>
      )}>
      {off ? (
        <Empty title="Offline receive is off">
          This server runs without solver discovery, so there are no solvers to manage. The README's “Offline receive” section shows how to turn it on.
        </Empty>
      ) : (
        <>
          {status.error && <LoadError error={status.error} retry={status.reload} />}
          {status.data && (
            <Alert tone={status.data.ready ? "ok" : "bad"} title={status.data.ready ? "Routing ready" : "Routing unavailable"}>
              <p>
                {plural(status.data.candidateCount, "routing candidate")} on {status.data.network}
                {status.data.refreshedAt ? `, refreshed ${ago(status.data.refreshedAt)}` : ""}.
              </p>
              {status.data.reason && <p>{sentence(status.data.reason)}</p>}
            </Alert>
          )}
          {status.data?.warnings.map((w) => <Alert key={w} tone="warn"><p>{sentence(w)}</p></Alert>)}

          <section className="section">
            <div className="section-head">
              <h2>Pasted cards</h2>
              <p className="small">Saved here for {status.data?.network ?? "this network"}; routing uses them alongside the registry.</p>
            </div>
            {cards.error && <LoadError error={cards.error} retry={cards.reload} />}
            {cards.loading ? <Loading what="cards" /> : !cards.data ? null : !cards.data.length ? (
              <Empty title="No pasted cards" action={<button type="button" className="btn" onClick={() => setAdding(true)}>Add solver card</button>}>
                Registry cards still route; they appear under Discovery sources.
              </Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Label</th><th>Solver</th><th>Network</th><th>In use</th><th>Updated</th><th /></tr></thead>
                  <tbody>
                    {cards.data.map((row) => (
                      <tr key={row.id}>
                        <td><strong>{row.label}</strong></td>
                        <td>{row.card.name ?? <span className="muted">unnamed</span>}</td>
                        <td>{row.network}</td>
                        <td>
                          <label className="inline">
                            <input type="checkbox" className="switch" checked={row.enabled} disabled={busy}
                              aria-label={`Use ${row.label} for routing`} onChange={() => void toggle(row)} />
                            <span className="small">{row.enabled ? "On" : "Off"}</span>
                          </label>
                        </td>
                        <td className="nowrap"><span title={when(row.updatedAt)}>{ago(row.updatedAt)}</span></td>
                        <td className="actions"><button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove(row)}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Discovery sources</h2>
              <p className="small">Where routing found its markets on the last refresh.</p>
            </div>
            {!status.data ? null : !status.data.sources.length ? <Empty title="No sources yet" /> : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Source</th><th>Status</th><th className="num">Markets</th><th>Cache</th></tr></thead>
                  <tbody>
                    {status.data.sources.map((s) => (
                      <tr key={`${s.source}:${s.cache ?? "live"}`}>
                        <td><code>{s.source}</code></td>
                        <td>{s.ok ? <Badge tone="ok">Healthy</Badge> : <Badge tone="bad">Failed</Badge>}{s.error && <span className="sub">{sentence(s.error)}</span>}</td>
                        <td className="num">{s.marketCount}</td>
                        <td>{s.cache ?? "live"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {adding && <AddCard onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void reload(); }} />}
    </Page>
  );
}

type Parsed = { card?: Record<string, unknown>; problem?: string };

function parseCard(json: string): Parsed {
  if (!json.trim()) return {};
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: "Paste one card: a JSON object, not a list or a value." };
    return { card: value as Record<string, unknown> };
  } catch (e) {
    return { problem: `Not valid JSON: ${errMsg(e)}` };
  }
}

function AddCard({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [json, setJson] = useState("");
  const [label, setLabel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error>();
  const toast = useToast();
  const { card, problem } = parseCard(json);
  const cardName = typeof card?.name === "string" ? card.name : "";
  const shownLabel = label ?? cardName;
  const markets = Array.isArray(card?.markets) ? card.markets.length : undefined;
  const key = typeof card?.discovery_pubkey === "string" ? card.discovery_pubkey : undefined;
  const blocker = !json.trim() ? "Paste a card to continue." : problem ? "Fix the JSON to continue." : !shownLabel.trim() ? "Give the card a label." : undefined;

  const save = async () => {
    if (blocker) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<SavedCard>("/solver-cards", { label: shownLabel.trim(), card });
      if (r.active) toast(`${shownLabel.trim()} saved; routing uses it now`);
      else toast(`${shownLabel.trim()} saved, but none of its markets is routable yet`, "warn");
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(errMsg(e)));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add solver card" wide onClose={onClose} onSubmit={() => void save()}
      footer={
        <>
          <span className="why" role="status">{blocker}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(blocker)}>{busy ? "Saving…" : "Save card"}</button>
        </>
      }>
      {error && (
        <Alert tone="bad" title={error.message}>
          {error instanceof ApiError && error.details?.length ? <ul>{error.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
        </Alert>
      )}
      <Field label="Card JSON" hint="The solver's signed card, as it publishes it. The server checks the signature and markets on save." error={problem}>
        {(p) => <textarea {...p} data-autofocus rows={10} spellCheck={false} className="mono" placeholder={'{ "version": 0, "name": "…", "markets": [ … ] }'} value={json} onChange={(e) => setJson(e.target.value)} />}
      </Field>
      {card && (
        <dl className="kv">
          <dt>Solver</dt><dd>{cardName || <span className="muted">no name</span>}</dd>
          <dt>Discovery key</dt><dd>{key ? <code>{key.slice(0, 20)}…</code> : <span className="muted">missing</span>}</dd>
          <dt>Markets</dt><dd>{markets ?? <span className="muted">none listed</span>}</dd>
        </dl>
      )}
      <Field label="Label" hint="Your name for this card in the list. Defaults to the solver's name.">
        {(p) => <input {...p} maxLength={100} placeholder={cardName || "Solver name"} value={shownLabel} onChange={(e) => setLabel(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
