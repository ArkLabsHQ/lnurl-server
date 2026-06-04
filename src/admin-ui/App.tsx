import { Fragment, useEffect, useState } from "react";
import { api } from "./api.js";

type Tab = "Dashboard" | "Domains" | "Addresses" | "API Keys" | "Blacklist";
const TABS: Tab[] = ["Dashboard", "Domains", "Addresses", "API Keys", "Blacklist"];
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
      </nav>
      {tab === "Dashboard" && <Dashboard />}
      {tab === "Domains" && <Domains />}
      {tab === "Addresses" && <Addresses />}
      {tab === "API Keys" && <ApiKeys />}
      {tab === "Blacklist" && <Blacklist />}
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
  const online = addresses.items.filter((a) => a.online).length;
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <Card label="Domains" value={domains.items.length} />
      <Card label="Addresses" value={addresses.items.length} />
      <Card label="Online now" value={online} />
    </div>
  );
}
function Card({ label, value }: { label: string; value: number }) {
  return <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, minWidth: 120 }}><div style={{ fontSize: 28 }}>{value}</div><div style={{ color: "#666" }}>{label}</div></div>;
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

function Th({ children }: { children?: React.ReactNode }) { return <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 6 }}>{children}</th>; }
function Td({ children }: { children?: React.ReactNode }) { return <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{children}</td>; }
