import { useEffect, useState } from "react";
import { api } from "./api.js";

type Tab = "Dashboard" | "Domains" | "Addresses" | "API Keys" | "Withdrawals";
const TABS: Tab[] = ["Dashboard", "Domains", "Addresses", "API Keys", "Withdrawals"];

interface Domain { id: number; domain: string; allocationModes: string[]; requireApiKey: boolean; enabled: boolean }
interface Address { id: number; username: string; domain: string | null; status: string; online: boolean }
interface ApiKey { id: number; label: string | null; status: string }
interface Withdrawal { id: string; status: string; minWithdrawable: number; maxWithdrawable: number }

export function App() {
  const [tab, setTab] = useState<Tab>("Addresses");
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 900, margin: "0 auto", padding: 16 }}>
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
      {tab === "Withdrawals" && <Withdrawals />}
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
  const add = async () => { await api.post("/domains", { domain, allocationModes: ["self", "random"] }); setDomain(""); reload(); };
  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      <div style={{ marginBottom: 12 }}>
        <input placeholder="new-domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <button onClick={add} disabled={!domain}>+ Add domain</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Domain</Th><Th>Modes</Th><Th>API key?</Th><Th>Enabled</Th><Th /></tr></thead>
        <tbody>{items.map((d) => (
          <tr key={d.id}><Td>{d.domain}</Td><Td>{d.allocationModes.join(", ")}</Td><Td>{d.requireApiKey ? "yes" : "no"}</Td><Td>{d.enabled ? "yes" : "no"}</Td>
            <Td><button onClick={async () => { await api.del(`/domains/${d.id}`); reload(); }}>Delete</button></Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Addresses() {
  const { items, reload, err } = useList<Address>("/addresses");
  const [domain, setDomain] = useState(""); const [username, setUsername] = useState(""); const [reveal, setReveal] = useState<string>();
  const create = async (mode: "reserve" | "mint") => {
    const r = await api.post<{ claimCode?: string; secret?: string }>("/addresses", { domain, username, mode });
    setReveal(r.claimCode ? `Claim code: ${r.claimCode}` : `Secret: ${r.secret}`); setUsername(""); reload();
  };
  return (
    <div>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {reveal && <p style={{ background: "#fffae6", padding: 8, borderRadius: 6 }}>{reveal} <button onClick={() => setReveal(undefined)}>dismiss</button></p>}
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <input placeholder="domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <button onClick={() => create("reserve")} disabled={!domain || !username}>Reserve</button>
        <button onClick={() => create("mint")} disabled={!domain || !username}>Mint</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Address</Th><Th>Status</Th><Th>Live</Th><Th /></tr></thead>
        <tbody>{items.map((a) => (
          <tr key={a.id}><Td>{a.username}@{a.domain}</Td><Td>{a.status}</Td><Td>{a.online ? "🟢" : "⚪"}</Td>
            <Td><button onClick={async () => { await api.patch(`/addresses/${a.id}`, { status: "revoked" }); reload(); }} disabled={a.status === "revoked"}>Revoke</button></Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ApiKeys() {
  const { items, reload } = useList<ApiKey>("/api-keys");
  const [label, setLabel] = useState(""); const [reveal, setReveal] = useState<string>();
  const create = async () => { const r = await api.post<{ key: string }>("/api-keys", { label }); setReveal(r.key); setLabel(""); reload(); };
  return (
    <div>
      {reveal && <p style={{ background: "#fffae6", padding: 8, borderRadius: 6 }}>Key (copy now): <code>{reveal}</code> <button onClick={() => setReveal(undefined)}>dismiss</button></p>}
      <div style={{ marginBottom: 12 }}><input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} /><button onClick={create}>+ Create key</button></div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr><Th>Label</Th><Th>Status</Th><Th /></tr></thead>
        <tbody>{items.map((k) => (
          <tr key={k.id}><Td>{k.label ?? "—"}</Td><Td>{k.status}</Td><Td><button onClick={async () => { await api.del(`/api-keys/${k.id}`); reload(); }} disabled={k.status === "revoked"}>Revoke</button></Td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Withdrawals() {
  const { items } = useList<Withdrawal>("/withdrawals");
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr><Th>Id</Th><Th>Status</Th><Th>Min</Th><Th>Max</Th></tr></thead>
      <tbody>{items.map((w) => (<tr key={w.id}><Td>{w.id.slice(0, 12)}…</Td><Td>{w.status}</Td><Td>{w.minWithdrawable}</Td><Td>{w.maxWithdrawable}</Td></tr>))}</tbody>
    </table>
  );
}

function Th({ children }: { children?: React.ReactNode }) { return <th style={{ textAlign: "left", borderBottom: "1px solid #ccc", padding: 6 }}>{children}</th>; }
function Td({ children }: { children?: React.ReactNode }) { return <td style={{ borderBottom: "1px solid #eee", padding: 6 }}>{children}</td>; }
