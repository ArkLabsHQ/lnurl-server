import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaymentOption, WalletBalance } from "@arkade-os/sdk";
import type { StoredPayment } from "@arkade-os/lnurl-client";
import { EXPLORER, LNURL_DOMAIN, USERNAME_KEY } from "./config.js";
import { createMnemonic, loadMnemonic, openWallet, wipeWallet, type DemoWallet } from "./wallet.js";
import { lnurl } from "./lnurl.js";
import { createRouter, RAIL_PRIORITY } from "./router.js";
import { localPaymentStore, storedPayments } from "./payment-store.js";
import { autoSettleBoarding, type BoardingState } from "./boarding.js";
import { Backup } from "./Backup.js";
import { Settings } from "./Settings.js";
import { forgetPayments } from "./payment-store.js";
import { ReceiveQr } from "./Qr.js";

type Tab = "Receive" | "Send" | "Activity" | "Settings";
const TABS: Tab[] = ["Receive", "Send", "Activity", "Settings"];

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

  const adopt = useCallback(async (mnemonic: string) => {
    setBooting(true);
    setErr(null);
    try {
      const w = await openWallet(mnemonic);
      setWallet(w);
      setToken(await lnurl.deriveToken(w.identity));

      // The username is not in the phrase, so on a fresh browser ask the server
      // which one this token owns. Re-registering it would fail: the server
      // refuses any existing username, owner or not.
      const token = await lnurl.deriveToken(w.identity);
      const owned = localStorage.getItem(USERNAME_KEY) ?? (await lnurl.ownedUsername(token).catch(() => undefined));
      if (owned) localStorage.setItem(USERNAME_KEY, owned);
      setUsername(owned ?? null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const mnemonic = loadMnemonic();
    if (!mnemonic) { setBooting(false); return; }
    // Same path as a restore: a phrase without a username is a phrase that has
    // to ask the server which one it owns, whether it arrived by restore or by
    // a browser that kept the key and lost the rest.
    void adopt(mnemonic);
  }, [adopt]);


  const forget = useCallback(() => {
    setWallet(null);
    setUsername(null);
    setToken(null);
  }, []);

  if (booting) return <div style={page}>Opening wallet…</div>;

  return (
    <div style={page}>
      <h1 style={{ fontSize: 20, marginBottom: 2 }}>Arkade demo wallet</h1>
      <p style={{ color: "#666", marginTop: 0, fontSize: 13 }}>mutinynet · receives through lnurl-server</p>
      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {!wallet || !username || !token
        ? <Onboarding wallet={wallet} username={username} onReady={(w, u, t) => { setWallet(w); setUsername(u); setToken(t); }} onError={setErr} />
        : <Wallet wallet={wallet} username={username} token={token} onRestored={adopt} onReset={forget} />}
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
        : await lnurl.onboard(w.identity, w.arkadeAddress, name.trim(), w.boardingAddress);
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

function Wallet({ wallet, username, token, onRestored, onReset }: {
  wallet: DemoWallet; username: string; token: string;
  onRestored: (mnemonic: string) => void; onReset: () => void;
}) {
  const [tab, setTab] = useState<Tab>("Receive");
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  // From the pinned domain, never location.hostname: this is served from GitHub
  // Pages, where the page's own host has nothing to do with the LNURL server.
  const lightningAddress = `${username}@${LNURL_DOMAIN}`;

  const [boarding, setBoarding] = useState<BoardingState>({ status: "idle" });

  const refresh = useCallback(() => {
    wallet.wallet.getBalance().then(setBalance).catch(() => undefined);
  }, [wallet]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Onchain arrivals are otherwise inert: they sit as boarding funds until
  // somebody settles them, and nothing in a receive demo should need a manual
  // step to turn received money into spendable money.
  useEffect(() => autoSettleBoarding(wallet.wallet, (state) => {
    setBoarding(state);
    if (state.status === "boarded") refresh();
  }), [wallet, refresh]);

  return (
    <>
      <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 16 }}>
        <div>
          <div style={{ fontSize: 28 }}>{balance?.available ?? "—"} <span style={{ fontSize: 14, color: "#666" }}>sats</span></div>
          <div style={{ color: "#666", fontSize: 12 }}>
            available · {balance?.settled ?? 0} settled · {balance?.preconfirmed ?? 0} preconfirmed
          </div>
        </div>
        {boarding.status !== "idle" && (
          <span style={{ ...mono, fontSize: 12, color: boarding.status === "failed" ? "crimson" : "#946200" }}>
            {boarding.status === "boarding" && `boarding ${boarding.sats} sats…`}
            {boarding.status === "boarded" && `boarded ${boarding.sats} sats`}
            {boarding.status === "failed" && `boarding failed: ${boarding.reason}`}
          </span>
        )}
        <button style={{ ...btn, marginLeft: "auto" }} onClick={refresh}>Refresh</button>
        <button style={btn} onClick={() => { wipeWallet(); forgetPayments(); onReset(); }}>Reset</button>
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
      {tab === "Activity" && <Activity token={token} username={username} lightningAddress={lightningAddress} />}
      {tab === "Settings" && (
        <>
          <Backup onRestored={onRestored} onReset={() => { forgetPayments(); onReset(); }} />
          <Settings onChanged={() => undefined} />
        </>
      )}
    </>
  );
}

function Receive({ lightningAddress, wallet }: { lightningAddress: string; wallet: DemoWallet }) {
  return (
    <>
      <div style={card}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Your Lightning address</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <ReceiveQr
            lightningAddress={lightningAddress}
            arkadeAddress={wallet.arkadeAddress}
            boardingAddress={wallet.boardingAddress}
          />
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
  const router = useMemo(() => createRouter(wallet), [wallet]);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState(1000);
  const [options, setOptions] = useState<PaymentOption[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState<string>();

  const findRoutes = async () => {
    setBusy(true); setStatus(""); setOptions(null);
    try {
      const found = await router.options({ raw: target.trim(), amount }, { priority: RAIL_PRIORITY });
      setOptions(found);
      if (!found.length) setStatus("no rail can pay that target at this amount");
    } catch (e) { setStatus(`routing failed: ${(e as Error).message}`); }
    finally { setBusy(false); }
  };

  // Quoted only on click: a quote asks the callback for an invoice, so pricing
  // every option up front would mint one per rail and abandon all but one.
  const pay = async (option: PaymentOption) => {
    // Quoting a swap rail is a live round trip to a solver and can take a
    // while or stall; without this the button only greys out and the wallet
    // looks like it ignored the click.
    setPaying(option.railId);
    setBusy(true); setStatus("");
    try {
      const quote = await option.quote();
      const handle = await quote.send();
      setStatus(`sent ${quote.amount} sats via ${quote.railId} · fee ${quote.fee} · ${handle.status}`);
      // Not awaiting settled(): a fire-and-forget rail is allowed never to
      // resolve it, which would hang the button forever.
      handle.subscribe((u) => {
        setStatus(`${quote.railId} · ${u.status}${u.error ? ` · ${String(u.error)}` : ""}`);
        if (u.status === "settled") onSent();
      });
      onSent();

      // The rail carries the receiver's LUD-21 verify URL when it has one.
      // Sending says the payment left; only this says the receiver got it —
      // and a rail whose destination cannot identify the payment supplies none,
      // so absence is "no answer available" rather than a failure.
      const verifyUrl = (quote.meta?.lnurl as { verify?: string } | undefined)?.verify;
      if (verifyUrl) {
        void lnurl.pollVerify(verifyUrl, { timeoutMs: 180_000, intervalMs: 2_000 })
          .then((v) => setStatus(v.settled
            ? `receiver confirmed settled via ${quote.railId}`
            : `receiver has not confirmed settlement via ${quote.railId}`))
          .catch((e: Error) => setStatus(`sent via ${quote.railId}, but verify failed: ${e.message}`));
      }
    } catch (e) { setStatus(`payment failed: ${(e as Error).message}`); }
    finally { setBusy(false); setPaying(undefined); }
  };

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Send</h2>
      <p style={{ color: "#555", fontSize: 13, marginTop: 0 }}>
        A Lightning address, an LNURL, an Arkade address or an on-chain address — the
        router decides which rails can serve it.
      </p>
      <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="name@domain, LNURL1…, tark1…, tb1…"
        style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", width: "100%", marginBottom: 8 }} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <input type="number" value={amount} min={1} onChange={(e) => setAmount(Number(e.target.value))}
          style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", width: 140 }} />
        <span style={{ color: "#666", fontSize: 13 }}>sats</span>
        <button style={btn} disabled={busy || !target.trim()} onClick={() => void findRoutes()}>
          {busy ? "Working…" : "Find routes"}
        </button>
      </div>

      {options?.map((option) => (
        <div key={option.railId} style={{ borderLeft: "4px solid #16834b", paddingLeft: 12, marginBottom: 8,
          display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ ...mono }}>{option.railId}</span>
          <button style={{ ...btn, marginLeft: "auto" }} disabled={busy} onClick={() => void pay(option)}>
            {paying === option.railId ? "Quoting…" : `Pay ${amount} sats`}
          </button>
        </div>
      ))}
      {status && <p style={{ ...mono, color: status.includes("failed") ? "crimson" : "#16834b" }}>{status}</p>}
    </div>
  );
}

function Activity({ token, username, lightningAddress }: { token: string; username: string; lightningAddress: string }) {
  const store = useMemo(() => localPaymentStore(), []);
  const [rows, setRows] = useState<StoredPayment[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    // Read the local store first so a closed-and-reopened wallet shows its
    // history immediately, then sync from the cursor rather than re-fetching.
    const show = () => { if (live) setRows(storedPayments(lightningAddress)); };
    show();
    const load = () => lnurl.syncActivity(token, username, store)
      .then(() => show())
      .catch((e: Error) => { if (live) setErr(e.message); });
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => { live = false; clearInterval(id); };
  }, [token, username, lightningAddress, store]);

  if (err) return <div style={card}><p style={{ color: "crimson" }}>{err}</p></div>;
  if (!rows) return <div style={card}>Loading…</div>;
  if (!rows.length) return <div style={card}><p style={{ color: "#666" }}>No payments yet.</p></div>;

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Payments to {username}</h2>
      {rows.map((r) => (
        <div key={r.key}
          style={{ display: "flex", gap: 12, padding: "8px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
          <span style={{ width: 70, color: "#666" }}>{r.kind === "bolt11" ? "lightning" : r.paymentOption ?? "destination"}</span>
          <span style={{ width: 90 }}>{r.amountMsat ? `${r.amountMsat / 1000} sats` : "—"}</span>
          <span style={{ color: r.settled ? "#16834b" : "#946200" }}>{r.settled ? "settled" : "pending"}</span>
          <span style={{ marginLeft: "auto", color: "#666" }}>{new Date(r.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
