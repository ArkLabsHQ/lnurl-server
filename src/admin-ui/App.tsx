import { Fragment, useEffect, useState } from "react";
import { api } from "./api.js";

type Tab = "Dashboard" | "Sessions" | "Settlements" | "Domains" | "Addresses" | "API Keys" | "Blacklist" | "Settings";
const TABS: Tab[] = ["Dashboard", "Sessions", "Settlements", "Domains", "Addresses", "API Keys", "Blacklist", "Settings"];
const ALLOCATION_MODES = ["self", "random", "admin"] as const;

interface Domain {
  id: number;
  domain: string;
  allocationModes: string[];
  requireApiKey: boolean;
  enabled: boolean;
  maxPerSession: number | null;
  usernameMinLen: number;
  usernameMaxLen: number;
  usernamePattern: string;
  minSendable: number | null;
  maxSendable: number | null;
}
interface Address { id: number; username: string; domain: string | null; status: string; online: boolean }
interface ApiKey { id: number; label: string | null; status: string; domainId: number | null }
interface BlacklistEntry { id: number; username: string; domainId: number | null; reason: string | null }
interface SessionAddress { username: string; domain: string | null; status: string }
interface SessionRow {
  sessionId: string;
  connectedAt: number;
  ip: string | null;
  reusable: boolean;
  invoicesIssued: number;
  lastInvoiceAt: number | null;
  pending: { amountMsat: number; comment?: string; since: number } | null;
  addresses: SessionAddress[];
}

/** Compact "Ns/Nm/Nh/Nd ago" from an epoch-ms timestamp. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function App() {
  const [tab, setTab] = useState<Tab>("Domains");
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>lnurl-admin</h1>
      <nav style={{ display: "flex", gap: 12, borderBottom: "1px solid #ccc", marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ background: "none", border: "none", padding: "8px 4px", cursor: "pointer",
              fontWeight: tab === t ? 700 : 400, borderBottom: tab === t ? "2px solid #333" : "2px solid transparent" }}>
            {t}
          </button>
        ))}
        <a href="/admin/api/docs" target="_blank" rel="noreferrer"
          style={{ marginLeft: "auto", padding: "8px 4px", color: "#06c", textDecoration: "none" }}>
          API Docs ↗
        </a>
      </nav>
      {tab === "Dashboard" && <Dashboard />}
      {tab === "Sessions" && <Sessions />}
      {tab === "Settlements" && <Settlements />}
      {tab === "Domains" && <Domains />}
      {tab === "Addresses" && <Addresses />}
      {tab === "API Keys" && <ApiKeys />}
      {tab === "Blacklist" && <Blacklist />}
      {tab === "Settings" && <Settings />}
    </div>
  );
}

function useList<T>(path: string, deps: unknown[] = []) {
  const [items, setItems] = useState<T[]>([]);
  const [err, setErr] = useState<string>();
  const reload = () => api.get<T[]>(path).then(setItems).catch((e: Error) => setErr(String(e.message)));
  useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, deps);
  return { items, err, reload };
}

function qs(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== "");
  return entries.length ? "?" + new URLSearchParams(entries).toString() : "";
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Dashboard() {
  const domains = useList<Domain>("/domains");
  const addresses = useList<Address>("/addresses");
  const sessions = useList<SessionRow>("/sessions");
  const online = addresses.items.filter((a) => a.online).length;
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <Card label="Domains" value={domains.items.length} />
      <Card label="Addresses" value={addresses.items.length} />
      <Card label="Online addresses" value={online} />
      <Card label="Live sessions" value={sessions.items.length} />
    </div>
  );
}
function Card({ label, value }: { label: string; value: number }) {
  return <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, minWidth: 120 }}><div style={{ fontSize: 28 }}>{value}</div><div style={{ color: "#666" }}>{label}</div></div>;
}

function Sessions() {
  const [items, setItems] = useState<SessionRow[]>([]);
  const [err, setErr] = useState<string>();
  const [mutErr, setMutErr] = useState<string>();
  const reload = () => api.get<SessionRow[]>("/sessions").then((r) => { setItems(r); setErr(undefined); }).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000); // live view: poll the in-memory session map
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);

  const disconnect = async (id: string) => {
    if (!confirm(`Disconnect session ${id.slice(0, 10)}…? The wallet's LNURL goes offline until it reconnects.`)) return;
    try { await api.post(`/sessions/${id}/disconnect`, {}); setMutErr(undefined); reload(); }
    catch (e) { setMutErr(errMsg(e)); }
  };

  const addressLabel = (a: SessionAddress) => `${a.username}@${a.domain ?? "?"}${a.status === "active" ? "" : ` (${a.status})`}`;

  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      <p style={{ color: "#666", marginTop: 0 }}>
        {items.length} live session{items.length === 1 ? "" : "s"} · auto-refreshes every 5s{" "}
        <button onClick={reload}>Refresh</button>
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Session</Th><Th>Addresses</Th><Th>Type</Th><Th>Connected</Th><Th>IP</Th><Th>Invoices</Th><Th>Pending</Th><Th /></tr></thead>
        <tbody>{items.map((s) => (
          <tr key={s.sessionId}>
            <Td><code title={s.sessionId}>{s.sessionId.slice(0, 10)}…</code></Td>
            <Td>{s.addresses.length
              ? s.addresses.map(addressLabel).join(", ")
              : <span style={{ color: "#999" }}>—</span>}</Td>
            <Td>{s.reusable ? "reusable" : "ephemeral"}</Td>
            <Td><span title={new Date(s.connectedAt).toLocaleString()}>{ago(s.connectedAt)}</span></Td>
            <Td>{s.ip ?? "—"}</Td>
            <Td>{s.invoicesIssued}{s.lastInvoiceAt ? <span style={{ color: "#666" }}> (last {ago(s.lastInvoiceAt)})</span> : null}</Td>
            <Td>{s.pending
              ? <span title={s.pending.comment ?? ""}>{s.pending.amountMsat.toLocaleString()} msat · {ago(s.pending.since)}</span>
              : "—"}</Td>
            <Td><button onClick={() => disconnect(s.sessionId)}>Disconnect</button></Td>
          </tr>
        ))}</tbody>
      </table>
      {items.length === 0 && <p style={{ color: "#999" }}>No wallets connected.</p>}
    </div>
  );
}

interface SettlementRow {
  paymentHash: string;
  sessionId: string;
  settled: boolean;
  swapId: string | null;
  paymentOption: string;
  paymentDestination: string | null;
  paymentReference: string | null;
  amountMsat: number | null;
  hasPreimage: boolean;
  createdAt: number;
  settledAt: number | null;
}

function Settlements() {
  const [items, setItems] = useState<SettlementRow[]>([]);
  const [err, setErr] = useState<string>();
  const [state, setState] = useState("");
  const [option, setOption] = useState("");
  const reload = () => api.get<SettlementRow[]>(`/settlements${qs({ settled: state, option })}`).then((r) => { setItems(r); setErr(undefined); }).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    reload();
    const t = setInterval(reload, 5000); // flips land on payment events — poll like Sessions
    return () => clearInterval(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [state, option]);

  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      <p style={{ color: "#666", marginTop: 0 }}>
        {items.length} record{items.length === 1 ? "" : "s"} · auto-refreshes every 5s{" "}
        <button onClick={reload}>Refresh</button>
      </p>
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">all states</option>
          <option value="false">pending</option>
          <option value="true">settled</option>
        </select>
        <select value={option} onChange={(e) => setOption(e.target.value)}>
          <option value="">all options</option>
          <option value="lightning">lightning</option>
          <option value="arkade">arkade</option>
        </select>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Created</Th><Th>Option</Th><Th>Amount</Th><Th>State</Th><Th>Destination</Th><Th>Reference</Th></tr></thead>
        <tbody>{items.map((s) => (
          <tr key={s.paymentHash}>
            <Td><span title={new Date(s.createdAt).toLocaleString()}>{ago(s.createdAt)}</span></Td>
            <Td>{s.paymentOption}{s.swapId ? " (offline swap)" : ""}</Td>
            <Td>{s.amountMsat != null ? `${s.amountMsat.toLocaleString()} msat` : "—"}</Td>
            <Td>{s.settled ? `settled${s.settledAt ? ` (${ago(s.settledAt)})` : ""}` : "pending"}{s.hasPreimage ? " · preimage held" : ""}</Td>
            <Td>{s.paymentDestination ? <code title={s.paymentDestination}>{s.paymentDestination.slice(0, 18)}…</code> : <span title={s.paymentHash}><code>{s.paymentHash.slice(0, 12)}…</code></span>}</Td>
            <Td>{s.paymentReference ? <code title={s.paymentReference}>{s.paymentReference.slice(0, 12)}…</code> : "—"}</Td>
          </tr>
        ))}</tbody>
      </table>
      {items.length === 0 && <p style={{ color: "#999" }}>No settlement records yet.</p>}
    </div>
  );
}

function Domains() {
  const { items, reload, err } = useList<Domain>("/domains");
  const [domain, setDomain] = useState("");
  const [mutErr, setMutErr] = useState<string>();
  const [editingId, setEditingId] = useState<number>();
  const add = async () => {
    try { await api.post("/domains", { domain, allocationModes: ["self", "random"] }); setDomain(""); setMutErr(undefined); reload(); }
    catch (e) { setMutErr(errMsg(e)); }
  };
  const del = async (id: number) => {
    try { await api.del(`/domains/${id}`); reload(); } catch (e) { setMutErr(errMsg(e)); }
  };
  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      <div style={{ marginBottom: 12 }}>
        <input placeholder="new-domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button onClick={add} disabled={!domain}>+ Add domain</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Domain</Th><Th>Modes</Th><Th>API key?</Th><Th>Enabled</Th><Th /></tr></thead>
        <tbody>{items.map((d) => (
          <Fragment key={d.id}>
            <tr>
              <Td>{d.domain}</Td><Td>{d.allocationModes.join(", ")}</Td><Td>{d.requireApiKey ? "yes" : "no"}</Td><Td>{d.enabled ? "yes" : "no"}</Td>
              <Td>
                <button onClick={() => setEditingId(editingId === d.id ? undefined : d.id)}>{editingId === d.id ? "Close" : "Edit"}</button>{" "}
                <button onClick={() => del(d.id)}>Delete</button>
              </Td>
            </tr>
            {editingId === d.id && <DomainEditor domain={d} onClose={() => setEditingId(undefined)} onSaved={reload} />}
          </Fragment>
        ))}</tbody>
      </table>
    </div>
  );
}

function DomainEditor({ domain, onClose, onSaved }: { domain: Domain; onClose: () => void; onSaved: () => void }) {
  const [modes, setModes] = useState<string[]>(domain.allocationModes);
  const [requireApiKey, setRequireApiKey] = useState(domain.requireApiKey);
  const [enabled, setEnabled] = useState(domain.enabled);
  const [maxPerSession, setMaxPerSession] = useState(domain.maxPerSession?.toString() ?? "");
  const [minLen, setMinLen] = useState(String(domain.usernameMinLen));
  const [maxLen, setMaxLen] = useState(String(domain.usernameMaxLen));
  const [pattern, setPattern] = useState(domain.usernamePattern);
  const [minSendable, setMinSendable] = useState(domain.minSendable?.toString() ?? "");
  const [maxSendable, setMaxSendable] = useState(domain.maxSendable?.toString() ?? "");
  const [err, setErr] = useState<string>();
  const [saving, setSaving] = useState(false);

  const toggleMode = (m: string) => setModes((cur) => (cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m]));
  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

  const save = async () => {
    setSaving(true); setErr(undefined);
    try {
      await api.patch(`/domains/${domain.id}`, {
        allocationModes: modes,
        requireApiKey,
        enabled,
        maxPerSession: numOrNull(maxPerSession),
        usernameMinLen: Number(minLen) || domain.usernameMinLen,
        usernameMaxLen: Number(maxLen) || domain.usernameMaxLen,
        usernamePattern: pattern,
        minSendable: numOrNull(minSendable),
        maxSendable: numOrNull(maxSendable),
      });
      onSaved(); onClose();
    } catch (e) { setErr(errMsg(e)); setSaving(false); }
  };

  return (
    <tr>
      <td colSpan={5} style={{ background: "#fafafa", padding: 12 }}>
        {err && <p style={{ color: "crimson", margin: "0 0 8px" }}>{err}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 12px", alignItems: "center", maxWidth: 560 }}>
          <span>Allocation modes</span>
          <div>{ALLOCATION_MODES.map((m) => (
            <label key={m} style={{ marginRight: 14 }}>
              <input type="checkbox" checked={modes.includes(m)} onChange={() => toggleMode(m)} /> {m}
            </label>
          ))}</div>

          <span>Require API key</span>
          <input type="checkbox" checked={requireApiKey} onChange={(e) => setRequireApiKey(e.target.checked)} />

          <span>Enabled</span>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />

          <span>Max per wallet</span>
          <input value={maxPerSession} placeholder="unlimited" onChange={(e) => setMaxPerSession(e.target.value)} style={{ width: 120 }} />

          <span>Username length</span>
          <span>min <input value={minLen} onChange={(e) => setMinLen(e.target.value)} style={{ width: 56 }} /> &nbsp; max <input value={maxLen} onChange={(e) => setMaxLen(e.target.value)} style={{ width: 56 }} /></span>

          <span>Username pattern</span>
          <input value={pattern} onChange={(e) => setPattern(e.target.value)} style={{ width: 180 }} />

          <span>Amount limits (msat)</span>
          <span>min <input value={minSendable} placeholder="global" onChange={(e) => setMinSendable(e.target.value)} style={{ width: 120 }} /> &nbsp; max <input value={maxSendable} placeholder="global" onChange={(e) => setMaxSendable(e.target.value)} style={{ width: 120 }} /></span>
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={save} disabled={saving}>Save</button>{" "}
          <button onClick={onClose} disabled={saving}>Cancel</button>
        </div>
      </td>
    </tr>
  );
}

function Addresses() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const { items, reload, err } = useList<Address>(`/addresses${qs({ q, status })}`, [q, status]);
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [reveal, setReveal] = useState<string>();
  const [mutErr, setMutErr] = useState<string>();

  const create = async (mode: "reserve" | "mint") => {
    try {
      const r = await api.post<{ claimCode?: string; secret?: string }>("/addresses", { domain, username, mode });
      setReveal(r.claimCode ? `Claim code: ${r.claimCode}` : `Secret: ${r.secret}`); setUsername(""); setMutErr(undefined); reload();
    } catch (e) { setMutErr(errMsg(e)); }
  };
  const setStatusOf = async (id: number, next: "active" | "revoked") => {
    try { await api.patch(`/addresses/${id}`, { status: next }); reload(); } catch (e) { setMutErr(errMsg(e)); }
  };
  const del = async (id: number) => {
    try { await api.del(`/addresses/${id}`); reload(); } catch (e) { setMutErr(errMsg(e)); }
  };

  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      {reveal && <p style={{ background: "#fffae6", padding: 8, borderRadius: 6 }}>{reveal} <button onClick={() => setReveal(undefined)}>dismiss</button></p>}
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <button onClick={() => create("reserve")} disabled={!domain || !username}>Reserve</button>
        <button onClick={() => create("mint")} disabled={!domain || !username}>Mint</button>
      </div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <input placeholder="search username…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">all statuses</option>
          <option value="reserved">reserved</option>
          <option value="active">active</option>
          <option value="revoked">revoked</option>
        </select>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Address</Th><Th>Status</Th><Th>Live</Th><Th /></tr></thead>
        <tbody>{items.map((a) => (
          <tr key={a.id}>
            <Td>{a.username}@{a.domain}</Td><Td>{a.status}</Td><Td>{a.online ? "online" : "offline"}</Td>
            <Td>
              {a.status === "revoked"
                ? <button onClick={() => setStatusOf(a.id, "active")}>Reactivate</button>
                : <button onClick={() => setStatusOf(a.id, "revoked")}>Revoke</button>}{" "}
              <button onClick={() => del(a.id)}>Delete</button>
            </Td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ApiKeys() {
  const { items, reload, err } = useList<ApiKey>("/api-keys");
  const domains = useList<Domain>("/domains");
  const [label, setLabel] = useState("");
  const [domainId, setDomainId] = useState(""); // "" = all domains
  const [reveal, setReveal] = useState<string>();
  const [mutErr, setMutErr] = useState<string>();

  const create = async () => {
    try {
      const r = await api.post<{ key: string }>("/api-keys", { label, domainId: domainId ? Number(domainId) : null });
      setReveal(r.key); setLabel(""); setDomainId(""); setMutErr(undefined); reload();
    } catch (e) { setMutErr(errMsg(e)); }
  };
  const revoke = async (id: number) => {
    try { await api.del(`/api-keys/${id}`); reload(); } catch (e) { setMutErr(errMsg(e)); }
  };
  const scopeOf = (id: number | null) => (id == null ? "all domains" : domains.items.find((d) => d.id === id)?.domain ?? `#${id}`);

  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      {reveal && <p style={{ background: "#fffae6", padding: 8, borderRadius: 6 }}>Key (copy now): <code>{reveal}</code> <button onClick={() => setReveal(undefined)}>dismiss</button></p>}
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          <option value="">all domains</option>
          {domains.items.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
        </select>
        <button onClick={create}>+ Create key</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Label</Th><Th>Scope</Th><Th>Status</Th><Th /></tr></thead>
        <tbody>{items.map((k) => (
          <tr key={k.id}><Td>{k.label ?? "—"}</Td><Td>{scopeOf(k.domainId)}</Td><Td>{k.status}</Td>
            <Td><button onClick={() => revoke(k.id)} disabled={k.status === "revoked"}>Revoke</button></Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Blacklist() {
  const { items, reload, err } = useList<BlacklistEntry>("/blacklist");
  const domains = useList<Domain>("/domains");
  const [username, setUsername] = useState("");
  const [domainId, setDomainId] = useState(""); // "" = global
  const [reason, setReason] = useState("");
  const [mutErr, setMutErr] = useState<string>();

  const add = async () => {
    try {
      await api.post("/blacklist", { username, domainId: domainId ? Number(domainId) : null, reason: reason || undefined });
      setUsername(""); setReason(""); setMutErr(undefined); reload();
    } catch (e) { setMutErr(errMsg(e)); }
  };
  const remove = async (id: number) => {
    try { await api.del(`/blacklist/${id}`); reload(); } catch (e) { setMutErr(errMsg(e)); }
  };
  const scopeOf = (id: number | null) => (id == null ? "global" : domains.items.find((d) => d.id === id)?.domain ?? `#${id}`);

  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      <div style={{ marginBottom: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
          <option value="">global (all domains)</option>
          {domains.items.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
        </select>
        <input placeholder="reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button onClick={add} disabled={!username}>+ Block</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Username</Th><Th>Scope</Th><Th>Reason</Th><Th /></tr></thead>
        <tbody>{items.map((b) => (
          <tr key={b.id}><Td>{b.username}</Td><Td>{scopeOf(b.domainId)}</Td><Td>{b.reason ?? "—"}</Td>
            <Td><button onClick={() => remove(b.id)}>Remove</button></Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

interface SettingView { value: number | string; default: number | string; overridden: boolean }
interface SettingsResponse { editable: Record<string, SettingView>; readOnly: Record<string, unknown> }
const SETTING_ORDER = ["minSendable", "maxSendable", "invoiceTimeoutMs", "baseUrl", "registrationRateLimitPerMin"] as const;
const SETTING_LABELS: Record<string, string> = {
  minSendable: "Min sendable (msat)",
  maxSendable: "Max sendable (msat)",
  invoiceTimeoutMs: "Invoice timeout (ms)",
  baseUrl: "Base URL",
  registrationRateLimitPerMin: "Registration rate limit (/min/IP)",
};

function Settings() {
  const [data, setData] = useState<SettingsResponse>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string>();
  const [mutErr, setMutErr] = useState<string>();
  const load = () => api.get<SettingsResponse>("/settings").then((d) => { setData(d); setDrafts({}); }).catch((e: Error) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (err) return <p style={{ color: "crimson" }}>{err}</p>;
  if (!data) return <p>Loading…</p>;

  const save = async (key: string) => {
    const raw = drafts[key];
    if (raw === undefined || raw === "") return;
    try { await api.patch("/settings", { [key]: key === "baseUrl" ? raw : Number(raw) }); setMutErr(undefined); load(); }
    catch (e) { setMutErr(errMsg(e)); }
  };
  const reset = async (key: string) => {
    try { await api.del(`/settings/${key}`); setMutErr(undefined); load(); } catch (e) { setMutErr(errMsg(e)); }
  };

  return (
    <div>
      {mutErr && <p style={{ color: "crimson" }}>{mutErr}</p>}
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Editable</h3>
      <p style={{ color: "#666", marginTop: 0 }}>Env value is the default; an override here takes effect live (no restart).</p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 24 }}>
        <thead><tr><Th>Setting</Th><Th>Effective</Th><Th>Default</Th><Th>New value</Th><Th /></tr></thead>
        <tbody>{SETTING_ORDER.map((key) => {
          const s = data.editable[key];
          if (!s) return null;
          return (
            <tr key={key}>
              <Td>{SETTING_LABELS[key] ?? key}</Td>
              <Td>{String(s.value)}{s.overridden && <span style={{ color: "#a60" }}> (override)</span>}</Td>
              <Td>{String(s.default)}</Td>
              <Td><input value={drafts[key] ?? ""} placeholder={String(s.value)} onChange={(e) => setDrafts({ ...drafts, [key]: e.target.value })} style={{ width: 160 }} /></Td>
              <Td>
                <button onClick={() => save(key)} disabled={!drafts[key]}>Save</button>{" "}
                {s.overridden && <button onClick={() => reset(key)}>Reset</button>}
              </Td>
            </tr>
          );
        })}</tbody>
      </table>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Read-only</h3>
      <p style={{ color: "#666", marginTop: 0 }}>Set via env vars; changing these needs a redeploy/restart.</p>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Setting</Th><Th>Value</Th></tr></thead>
        <tbody>{Object.entries(data.readOnly).map(([k, v]) => (
          <tr key={k}><Td>{k}</Td><Td>{v === null ? "—" : String(v)}</Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) { return <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 6 }}>{children}</th>; }
function Td({ children }: { children?: React.ReactNode }) { return <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{children}</td>; }
