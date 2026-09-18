import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletBalance } from "@arkade-os/sdk";
import type { PaymentActivity, PayRequest } from "@arkade-os/lnurl-client";
import { EXPLORER, USERNAME_KEY } from "./config.js";
import { createMnemonic, forgetWallet, loadMnemonic, openWallet, sendToArkadeAddress, type DemoWallet } from "./wallet.js";
import { chooseRail, lnurl } from "./lnurl.js";
import { Qr } from "./Qr.js";

type Tab = "Receive" | "Send" | "Activity";
const TABS: Tab[] = ["Receive", "Send", "Activity"];

const page = { fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 16 } as const;
const card = { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 16 } as const;
const mono = { fontFamily: "ui-monospace, monospace", fontSize: 13, wordBreak: "break-all" } as const;
const btn = { padding: "8px 14px", borderRadius: 6, border: "1px solid #bbb", background: "#fafafa", cursor: "pointer" } as const;

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      style={{ ...btn, padding: "2px 8px", fontSize: 12, marginLeft: 8 }}
      onClick={() => { void navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200); }}
    >{done ? "copied" : "copy"}</button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ color: "#666", fontSize: 12, marginBottom: 2 }}>{label}<Copy value={value} /></div>
      <div style={mono}>{value}</div>
    </div>
  );
}

export function App() {
  const [wallet, setWallet] = useState<DemoWallet | null>(null);
  const [username, setUsername] = useState<string | null>(() => localStorage.getItem(USERNAME_KEY));
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const mnemonic = loadMnemonic();
    if (!mnemonic) { setBooting(false); return; }
    openWallet(mnemonic)
      .then(async (w) => { setWallet(w); setToken(await lnurl.deriveToken(w.identity)); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div style={page}>Opening wallet…</div>;

  return (
    <div style={page}>
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>Arkade demo wallet</h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: 13 }}>mutinynet · receives through lnurl-server</p>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {!wallet || !username || !token
        ? <Onboarding wallet={wallet} username={username} onReady={(w, u, t) => { setWallet(w); setUsername(u); setToken(t); }} onError={setErr} />
        : <Wallet wallet={wallet} username={username} token={token} />}
    </div>
  );
}

function Onboarding({ wallet, username, onReady, onError }: {
  wallet: DemoWallet | null;
  username: string | null;
  onReady: (w: DemoWallet, u: string, t: string) => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const go = useCallback(async () => {
    setBusy(true);
    onError("");
    try {
      const w = wallet ?? (await openWallet(loadMnemonic() ?? createMnemonic()));
      // Claim the name and bind the identity in one step: an address without a
      // bound identity advertises no rails, so a half-done onboarding is a
      // wallet that silently cannot receive.
      const result = username
        ? { token: await lnurl.deriveToken(w.identity), username }
        : await lnurl.onboard(w.identity, w.arkadeAddress, name.trim());
      localStorage.setItem(USERNAME_KEY, result.username);
      onReady(w, result.username, result.token);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [wallet, username, name, onReady, onError]);

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Create your wallet</h2>
      <p style={{ color: "#555", fontSize: 14 }}>
        Generates an Arkade identity, claims a Lightning address, and binds the identity
        so payments can arrive while this page is closed.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="username"
        style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", marginRight: 8, minWidth: 200 }}
      />
      <button style={btn} disabled={busy || name.trim().length < 3} onClick={() => void go()}>
        {busy ? "Working…" : "Create wallet"}
      </button>
    </div>
  );
}

function Wallet({ wallet, username, token }: { wallet: DemoWallet; username: string; token: string }) {
  const [tab, setTab] = useState<Tab>("Receive");
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const lightningAddress = `${username}@${location.hostname === "localhost" ? "lnurl.mutinynet.arkade.sh" : location.hostname}`;

  const refresh = useCallback(() => {
    wallet.wallet.getBalance().then(setBalance).catch(() => undefined);
  }, [wallet]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <>
      <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 16 }}>
        <div>
          <div style={{ fontSize: 28 }}>{balance?.available ?? "—"} <span style={{ fontSize: 14, color: "#666" }}>sats</span></div>
          <div style={{ color: "#666", fontSize: 12 }}>
            available · {balance?.settled ?? 0} settled · {balance?.preconfirmed ?? 0} preconfirmed
          </div>
        </div>
        <button style={{ ...btn, marginLeft: "auto" }} onClick={refresh}>Refresh</button>
        <button style={btn} onClick={() => { forgetWallet(); location.reload(); }}>Reset</button>
      </div>

      <nav style={{ display: "flex", gap: 12, borderBottom: "1px solid #ccc", marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ background: "none", border: "none", padding: "8px 4px", cursor: "pointer",
              borderBottom: tab === t ? "2px solid #111" : "2px solid transparent", fontWeight: tab === t ? 600 : 400 }}>
            {t}
          </button>
        ))}
      </nav>

      {tab === "Receive" && <Receive lightningAddress={lightningAddress} wallet={wallet} />}
      {tab === "Send" && <Send wallet={wallet} onSent={refresh} />}
      {tab === "Activity" && <Activity token={token} username={username} />}
    </>
  );
}

function Receive({ lightningAddress, wallet }: { lightningAddress: string; wallet: DemoWallet }) {
  return (
    <>
      <div style={card}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Your Lightning address</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Qr text={`lightning:${lightningAddress}`} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <Field label="Lightning address" value={lightningAddress} />
            <Field label="Arkade address" value={wallet.arkadeAddress} />
            <p style={{ color: "#555", fontSize: 13 }}>
              Payments arrive whether or not this page is open: the server takes the swap
              or covenant destination on your behalf, constrained to pay the address above.
            </p>
          </div>
        </div>
      </div>
      <div style={card}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Fund this wallet</h2>
        <p style={{ color: "#555", fontSize: 13, marginTop: 0 }}>
          Send mutinynet BTC to the boarding address, then onboard it to spend offchain.
        </p>
        <Field label="Boarding address (onchain)" value={wallet.boardingAddress} />
        <a href={EXPLORER} target="_blank" rel="noreferrer" style={{ color: "#06c", fontSize: 13 }}>explorer</a>
      </div>
    </>
  );
}

function Send({ wallet, onSent }: { wallet: DemoWallet; onSent: () => void }) {
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState(1000);
  const [pr, setPr] = useState<PayRequest | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const doResolve = async () => {
    setBusy(true); setStatus(""); setPr(null);
    try {
      setPr(await lnurl.resolveTarget(target));
    } catch (e) { setStatus(`resolve failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  const doPay = async () => {
    if (!pr) return;
    setBusy(true); setStatus("");
    try {
      const rail = chooseRail(pr.paymentOptions);
      const result = await lnurl.requestPayment(pr, amount, rail);
      if (result.kind === "destination" && result.paymentDestination) {
        const txid = await sendToArkadeAddress(wallet.wallet, result.paymentDestination, amount);
        setStatus(`paid over the ${result.paymentOption} rail · ${txid}`);
        onSent();
      } else if (result.kind === "bolt11") {
        // No Lightning node here, so a BOLT11 is as far as this wallet can take it.
        setStatus(`server returned a BOLT11 invoice; this wallet cannot pay it: ${result.pr.slice(0, 40)}…`);
      } else {
        setStatus("callback returned no payable destination");
      }
    } catch (e) { setStatus(`payment failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Send</h2>
      <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="name@domain or LNURL1…"
        style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", width: "100%", marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input type="number" value={amount} min={1} onChange={(e) => setAmount(Number(e.target.value))}
          style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", width: 140 }} />
        <span style={{ color: "#666", fontSize: 13 }}>sats</span>
        <button style={btn} disabled={busy || !target.trim()} onClick={() => void doResolve()}>Resolve</button>
      </div>

      {pr && (
        <div style={{ borderLeft: "4px solid #16834b", paddingLeft: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: "#555" }}>
            accepts {pr.minSendable / 1000}–{pr.maxSendable / 1000} sats
          </div>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            rails: {pr.paymentOptions?.length ? pr.paymentOptions.map((o) => o.id).join(", ") : "lightning only (no Arkade identity bound)"}
          </div>
          <button style={btn} disabled={busy} onClick={() => void doPay()}>
            {busy ? "Paying…" : `Pay ${amount} sats via ${chooseRail(pr.paymentOptions) ?? "lightning"}`}
          </button>
        </div>
      )}
      {status && <p style={{ ...mono, color: status.includes("failed") ? "crimson" : "#16834b" }}>{status}</p>}
    </div>
  );
}

function Activity({ token, username }: { token: string; username: string }) {
  const [rows, setRows] = useState<PaymentActivity[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    const load = () => lnurl.payments(token, username)
      .then((p) => { if (live) setRows(p); })
      .catch((e: Error) => { if (live) setErr(e.message); });
    load();
    const id = setInterval(load, 8000);
    return () => { live = false; clearInterval(id); };
  }, [token, username]);

  if (err) return <div style={card}><p style={{ color: "crimson" }}>{err}</p></div>;
  if (!rows) return <div style={card}>Loading…</div>;
  if (!rows.length) return <div style={card}><p style={{ color: "#666" }}>No payments yet.</p></div>;

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Payments to {username}</h2>
      {rows.map((r) => (
        <div key={r.kind === "bolt11" ? r.paymentHash : r.verifyId}
          style={{ display: "flex", gap: 12, padding: "8px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
          <span style={{ width: 70, color: "#666" }}>{r.kind === "bolt11" ? "lightning" : r.paymentOption}</span>
          <span style={{ width: 90 }}>{r.amountMsat ? `${r.amountMsat / 1000} sats` : "—"}</span>
          <span style={{ color: r.settled ? "#16834b" : "#946200" }}>{r.settled ? "settled" : "pending"}</span>
          <span style={{ marginLeft: "auto", color: "#666" }}>{new Date(r.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
