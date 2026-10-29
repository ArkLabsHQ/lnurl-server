import { useId, useState } from "react";
import { api, errMsg, notConfigured, type QuoteUnitRow } from "../api.js";
import { ago, decimal, intProblem, when } from "../lib.js";
import { Alert, Badge, Empty, Field, LoadError, Loading, Page, Wizard, useAction, useConfirm, useLoad, useToast } from "../ui.js";

const UNITS: Record<string, { name: string; decimals: number }> = {
  USD: { name: "US dollar", decimals: 2 },
  EUR: { name: "Euro", decimals: 2 },
  GBP: { name: "Pound sterling", decimals: 2 },
  CHF: { name: "Swiss franc", decimals: 2 },
  CAD: { name: "Canadian dollar", decimals: 2 },
  AUD: { name: "Australian dollar", decimals: 2 },
  JPY: { name: "Japanese yen", decimals: 0 },
  BRL: { name: "Brazilian real", decimals: 2 },
  MXN: { name: "Mexican peso", decimals: 2 },
  ARS: { name: "Argentine peso", decimals: 2 },
  ZAR: { name: "South African rand", decimals: 2 },
  NGN: { name: "Nigerian naira", decimals: 2 },
  INR: { name: "Indian rupee", decimals: 2 },
  USDT: { name: "Tether", decimals: 6 },
  USDC: { name: "USD Coin", decimals: 6 },
};

// Coinbase leads because CoinGecko answers this server's feed reader with 403 (it wants a User-Agent).
// Empty paths are the shapes the server derives a pointer for (src/price-feed.ts defaultPricePath).
const FEEDS: Record<string, { label: string; url: (code: string) => string; path: string }> = {
  coinbase: { label: "Coinbase", url: (c) => `https://api.coinbase.com/v2/prices/BTC-${c}/spot`, path: "/data/amount" },
  binance: { label: "Binance", url: (c) => `https://api.binance.com/api/v3/ticker/price?symbol=BTC${c}`, path: "" },
  coingecko: { label: "CoinGecko", url: (c) => `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${c.toLowerCase()}`, path: "" },
};

const CODE = /^[A-Z][A-Z0-9]{0,15}$/;
const sourceOf = (u: QuoteUnitRow) => Object.keys(FEEDS).find((k) => FEEDS[k]!.url(u.code) === u.feedUrl) ?? "custom";

export function Quotes() {
  const list = useLoad(() => api.get<QuoteUnitRow[]>("/quote-units"), []);
  const [editing, setEditing] = useState<QuoteUnitRow | "new">();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const off = list.error && notConfigured(list.error);
  const remove = async (u: QuoteUnitRow) => {
    if (!await confirm({
      title: `Remove ${u.code}?`,
      body: <p>{u.overridesEnv ? `The ${u.code} feed from QUOTE_UNITS takes over again.` : `Payers can no longer price payments in ${u.code}.`}</p>,
      confirmLabel: `Remove ${u.code}`,
      danger: !u.overridesEnv,
    })) return;
    await run(async () => { await api.del(`/quote-units/${encodeURIComponent(u.code)}`); await list.reload(); }, `${u.code} removed`);
  };

  return (
    <Page title="Quotes" intro="Currencies payers can price a payment in. Each converts at a live BTC price and is offered only while that price is fresh."
      actions={!off && (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { await api.post("/quote-units/refresh", {}); await list.reload(); }, "Prices refreshed")}>Refresh prices</button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>Add unit</button>
        </>
      )}>
      {off ? <Empty title="Payment quotes are off">This server was started without a quote provider, so payers can only pay in sats.</Empty> : (
        <>
          {list.error && <LoadError error={list.error} retry={list.reload} />}
          {list.loading ? <Loading what="units" /> : !list.data ? null : !list.data.length ? (
            <Empty title="No units yet" action={<button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>Add unit</button>}>
              Add USD, EUR or another currency so payers can enter amounts in it.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Unit</th><th className="num">Price per BTC</th><th>Status</th><th>Source</th><th>Feed</th><th /></tr></thead>
                <tbody>
                  {list.data.map((u) => (
                    <tr key={u.code}>
                      <td><strong>{u.code}</strong><span className="sub">{UNITS[u.code] ? `${UNITS[u.code]!.name}, ` : ""}{u.decimals} decimals</span></td>
                      <td className="num nowrap">
                        {u.price ? decimal(u.price) : "—"}
                        {u.updatedAt && <span className="sub" title={when(u.updatedAt)}>{ago(u.updatedAt)}</span>}
                      </td>
                      <td>
                        {u.fresh ? <Badge tone="ok">Live</Badge> : <Badge tone="bad" title="Not offered to payers until its price refreshes">Stale</Badge>}
                        {u.error && <span className="sub">{u.error}</span>}
                      </td>
                      <td>
                        {u.source === "env" ? "Environment" : "Saved here"}
                        {(u.source === "env" || u.overridesEnv) && <span className="sub">{u.source === "env" ? "QUOTE_UNITS" : "replaces QUOTE_UNITS"}</span>}
                      </td>
                      <td>
                        <span className="ellipsis small" title={u.feedUrl}>{u.feedUrl}</span>
                        <span className="sub">{u.pricePath || "path derived from URL"}</span>
                      </td>
                      <td className="actions">
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(u)}>{u.source === "env" ? "Override" : "Edit"}</button>
                        {u.source === "admin" && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove(u)}>Remove</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {editing && (
        <UnitWizard unit={editing === "new" ? undefined : editing} existing={list.data ?? []} onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); void list.reload(); }} />
      )}
    </Page>
  );
}

function UnitWizard({ unit, existing, onClose, onSaved }: { unit?: QuoteUnitRow; existing: QuoteUnitRow[]; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(unit?.code ?? "");
  const [decimals, setDecimals] = useState(unit ? String(unit.decimals) : "2");
  const [decimalsTouched, setDecimalsTouched] = useState(Boolean(unit));
  const [source, setSource] = useState(unit ? sourceOf(unit) : "coinbase");
  const [feedUrl, setFeedUrl] = useState(unit?.feedUrl ?? "");
  const [pricePath, setPricePath] = useState(unit?.pricePath ?? "");
  const [tested, setTested] = useState<{ url: string; path: string; price: string }>();
  const [testError, setTestError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const listId = useId();

  const url = feedUrl.trim();
  const path = pricePath.trim();
  const codeProblem = code && !CODE.test(code) ? "Letters and digits, starting with a letter: USD, EUR, USDT." : undefined;
  const decimalsProblem = intProblem(decimals, { min: 0, max: 18 });
  const urlProblem = url && !/^https?:\/\/\S+$/.test(url) ? "Enter an http(s) URL." : undefined;
  const pathProblem = path && !path.startsWith("/") ? "A JSON pointer starts with /, like /data/amount." : undefined;
  const isTested = tested?.url === url && tested.path === path;
  const replacing = existing.find((u) => u.code === code);
  const feed = { feedUrl: url, ...(path ? { pricePath: path } : {}) };

  const pickCode = (raw: string) => {
    const next = raw.toUpperCase().replace(/\s/g, "");
    setCode(next);
    if (!decimalsTouched && UNITS[next]) setDecimals(String(UNITS[next].decimals));
    const preset = FEEDS[source];
    if (preset) {
      setFeedUrl(next ? preset.url(next) : "");
      setPricePath(preset.path);
    }
  };
  const pickSource = (next: string) => {
    setSource(next);
    const preset = FEEDS[next];
    if (preset && code) {
      setFeedUrl(preset.url(code));
      setPricePath(preset.path);
    }
  };
  const test = async () => {
    setTesting(true);
    setTestError(undefined);
    try {
      const r = await api.post<{ price: string }>("/quote-units/preview", feed);
      setTested({ url, path, price: r.price });
    } catch (e) {
      setTested(undefined);
      setTestError(errMsg(e));
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.put(`/quote-units/${encodeURIComponent(code)}`, { ...feed, decimals: Number(decimals) });
      toast(`${code} saved`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  const codeHint = replacing
    ? replacing.source === "env" ? `Replaces the ${code} feed from QUOTE_UNITS while saved here.` : `Replaces the saved ${code} feed.`
    : UNITS[code]?.name ?? "Pick from the list or type any code.";

  return (
    <Wizard title={unit ? `${unit.source === "env" ? "Override" : "Edit"} ${unit.code}` : "Add quote unit"} finishLabel="Save unit"
      onFinish={() => void save()} onClose={onClose} busy={busy} error={error}
      steps={[
        {
          title: "Unit",
          blocker: !code ? "Enter a unit code to continue." : codeProblem || decimalsProblem ? "Fix the highlighted fields to continue." : undefined,
          body: (
            <div className="field-row">
              <Field label="Code" hint={codeHint} error={codeProblem}>
                {(p) => (
                  <>
                    <input {...p} data-autofocus={unit ? undefined : true} readOnly={Boolean(unit)} list={listId} maxLength={16} autoComplete="off"
                      placeholder="USD" value={code} onChange={(e) => pickCode(e.target.value)} />
                    <datalist id={listId}>
                      {Object.entries(UNITS).map(([c, u]) => <option key={c} value={c}>{u.name}, {u.decimals} decimals</option>)}
                    </datalist>
                  </>
                )}
              </Field>
              <Field label="Decimals" error={decimalsProblem}
                hint="Digits in its smallest amount: 2 for cents, 6 for USDT. A wrong value misprices by a power of ten.">
                {(p) => <input {...p} data-autofocus={unit ? true : undefined} type="number" min={0} max={18} step={1} value={decimals}
                  onChange={(e) => { setDecimals(e.target.value); setDecimalsTouched(true); }} />}
              </Field>
            </div>
          ),
        },
        {
          title: "Price feed",
          blocker: !url ? "Enter a feed URL to continue."
            : urlProblem || pathProblem ? "Fix the highlighted fields to continue."
            : !isTested ? "Test the feed to continue." : undefined,
          body: (
            <>
              <Field label="Source" hint={`Any JSON endpoint that answers the price of one whole bitcoin in ${code}.`}>
                {(p) => (
                  <select {...p} data-autofocus value={source} onChange={(e) => pickSource(e.target.value)}>
                    {Object.entries(FEEDS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
                    <option value="custom">Custom URL</option>
                  </select>
                )}
              </Field>
              <Field label="Feed URL" error={urlProblem} hint="Must answer before it can be saved; private and loopback hosts are refused.">
                {(p) => <input {...p} type="url" spellCheck={false} placeholder="https://…" value={feedUrl}
                  onChange={(e) => { setFeedUrl(e.target.value); if (FEEDS[source]?.url(code) !== e.target.value) setSource("custom"); }} />}
              </Field>
              <Field label="Price path" error={pathProblem}
                hint="JSON pointer to the price in the response, like /data/amount. Leave empty for CoinGecko and Binance URLs.">
                {(p) => <input {...p} className="mono" spellCheck={false} placeholder="Derived from the URL" value={pricePath} onChange={(e) => setPricePath(e.target.value)} />}
              </Field>
              <div className="inline">
                <button type="button" className="btn" disabled={!url || Boolean(urlProblem || pathProblem) || testing} onClick={() => void test()}>
                  {testing ? "Testing…" : "Test feed"}
                </button>
                {isTested && <span className="badge ok">1 BTC = {decimal(tested.price)} {code}</span>}
              </div>
              {testError && !isTested && <Alert tone="bad" title="The feed didn't give a price"><p>{testError}</p></Alert>}
            </>
          ),
        },
        {
          title: "Review",
          body: (
            <>
              <dl className="kv">
                <dt>Unit</dt><dd><strong>{code}</strong>{UNITS[code] ? `, ${UNITS[code]!.name}` : ""}</dd>
                <dt>Decimals</dt><dd>{decimals}</dd>
                <dt>Feed</dt><dd className="small">{url}</dd>
                <dt>Price path</dt><dd>{path ? <code>{path}</code> : "Derived from the URL"}</dd>
                <dt>Price now</dt><dd>{tested ? `1 BTC = ${decimal(tested.price)} ${code}` : "—"}</dd>
              </dl>
              {replacing && <Alert tone="info"><p>{codeHint}</p></Alert>}
            </>
          ),
        },
      ]} />
  );
}
