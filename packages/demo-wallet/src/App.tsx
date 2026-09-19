import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaymentOption, WalletBalance } from "@arkade-os/sdk";
import type { InvoiceResult, PayRequest } from "@arkade-os/lnurl-client";
import { EXPLORER, LNURL_DOMAIN, USERNAME_KEY } from "./config.js";
import { mergeFeed, readWalletActivity, type FeedRow, type FeedStatus } from "./activity.js";
import { createMnemonic, loadMnemonic, openWallet, wipeWallet, type DemoWallet } from "./wallet.js";
import { lnurl } from "./lnurl.js";
import { createRouter, RAIL_PRIORITY } from "./router.js";
import { localPaymentStore, storedPayments } from "./payment-store.js";
import { autoSettleBoarding, type BoardingState } from "./boarding.js";
import { Backup } from "./Backup.js";
import { Settings } from "./Settings.js";
import { forgetPayments } from "./payment-store.js";
import { CopyableQr, ReceiveQr } from "./Qr.js";

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

      {tab === "Receive" && <Receive lightningAddress={lightningAddress} />}
      {tab === "Send" && <Send wallet={wallet} onSent={refresh} />}
      {tab === "Activity" && <Activity token={token} username={username} lightningAddress={lightningAddress} wallet={wallet} />}
      {tab === "Settings" && (
        <>
          <Backup onRestored={onRestored} onReset={() => { forgetPayments(); onReset(); }} />
          <Settings onChanged={() => undefined} />
        </>
      )}
    </>
  );
}

/**
 * The address is the whole interface. Nothing here shows an Arkade or boarding
 * address, because a payer never needs one: they resolve the address, read the
 * rails it offers, and ask for the one they want. Funding this wallet is the
 * same act — request the `onchain` option and pay what it answers with.
 *
 * Options are listed on demand and requested one at a time, never eagerly: a
 * callback mints a destination and files a settlement record, so rendering the
 * list by calling every rail would leave a trail of quotes nobody asked for.
 */
function Receive({ lightningAddress }: { lightningAddress: string }) {
  const [payRequest, setPayRequest] = useState<PayRequest | null>(null);
  const [amount, setAmount] = useState(1000);
  const [result, setResult] = useState<{ option: string; value: InvoiceResult } | null>(null);
  const [settled, setSettled] = useState<string>("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = async () => {
    setBusy("options"); setErr(""); setResult(null); setSettled("");
    try { setPayRequest(await lnurl.ownPayRequest(lightningAddress.split("@")[0]!)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  };

  const request = async (optionId: string) => {
    setBusy(optionId); setErr(""); setResult(null); setSettled("");
    try {
      const value = await lnurl.requestPayment(payRequest!, amount, optionId === "lightning" ? undefined : optionId);
      setResult({ option: optionId, value });
      // Absence is "no answer available", not failure: only a destination that
      // identifies the payment gets a verify URL. @see lnurl.ts
      if (value.verify) {
        void lnurl.pollVerify(value.verify, { timeoutMs: 300_000, intervalMs: 3_000 })
          .then((v) => setSettled(v.settled ? "settled" : "not settled within the poll window"))
          .catch((e: Error) => setSettled(`verify failed: ${e.message}`));
      }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  };

  const options = payRequest?.paymentOptions ?? (payRequest ? [{ id: "lightning", type: "lightning" }] : []);

  return (
    <>
      <div style={card}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>Your Lightning address</h2>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <ReceiveQr lightningAddress={lightningAddress} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <Field label="Lightning address" value={lightningAddress} />
            <p style={{ color: "#555", fontSize: 13 }}>
              Everything this wallet receives arrives through this one address, open page or
              not — the server takes the swap or destination on your behalf, constrained to
              pay you. To fund it, request the <code>onchain</code> rail below and pay what
              it hands back.
            </p>
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 16, marginTop: 0 }}>What this address accepts</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <button style={btn} disabled={busy !== ""} onClick={() => void load()}>
            {busy === "options" ? "Resolving…" : payRequest ? "Reload options" : "Load options"}
          </button>
          <input type="number" value={amount} min={1} onChange={(e) => setAmount(Number(e.target.value))}
            style={{ padding: 8, borderRadius: 6, border: "1px solid #bbb", width: 120 }} />
          <span style={{ color: "#666", fontSize: 13 }}>sats</span>
        </div>

        {payRequest && (
          <p style={{ color: "#666", fontSize: 12, marginTop: 0 }}>
            accepts {payRequest.minSendable / 1000}–{payRequest.maxSendable / 1000} sats
          </p>
        )}

        {options.map((option) => (
          <div key={option.id}
            style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
            <span style={{ width: 90 }}>{option.id}</span>
            <span style={{ color: "#666", flex: 1 }}>
              {option.minSendable !== undefined && option.maxSendable !== undefined
                ? `${option.minSendable / 1000}–${option.maxSendable / 1000} sats`
                : "inherits the address bounds"}
            </span>
            <button style={btn} disabled={busy !== ""} onClick={() => void request(option.id)}>
              {busy === option.id ? "Requesting…" : `Request ${amount} sats`}
            </button>
          </div>
        ))}

        {err && <p style={{ ...mono, color: "crimson" }}>{err}</p>}
        {result && (() => {
          const payable = (result.value.kind === "bolt11" ? result.value.pr : result.value.paymentDestination) ?? "";
          return (
            <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12, display: "flex", gap: 20, flexWrap: "wrap" }}>
              <CopyableQr uri={payable} caption={`${result.option} · ${amount} sats`} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <Field label={`${result.option} — pay this`} value={payable} />
                <p style={{ color: "#666", fontSize: 12 }}>
                  {result.value.verify
                    ? settled || "polling verify…"
                    : "no verify on this rail — the server cannot say whether this was paid"}
                </p>
              </div>
            </div>
          );
        })()}
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

const STATUS_STYLE: Record<FeedStatus, { color: string; text: string; title: string }> = {
  settled: { color: "#16834b", text: "settled", title: "Confirmed." },
  pending: { color: "#946200", text: "pending", title: "Quoted, not yet observed as paid." },
  untracked: {
    color: "#888",
    text: "not tracked",
    title: "This rail pays a Bitcoin address, and the server watches the Arkade indexer rather than Bitcoin — so it never reports settlement, whether or not the payment arrived.",
  },
};

function Activity({ token, username, lightningAddress, wallet }: {
  token: string; username: string; lightningAddress: string; wallet: DemoWallet;
}) {
  const store = useMemo(() => localPaymentStore(), []);
  const [rows, setRows] = useState<FeedRow[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    // The wallet half comes from the SDK and needs no server, so it renders even
    // when the sync fails — which is also why the error does not replace the list.
    const show = async () => {
      if (!live) return;
      const activities = await readWalletActivity(wallet.wallet);
      if (live) setRows(mergeFeed(activities, storedPayments(lightningAddress)));
    };
    void show();
    const load = () => lnurl.syncActivity(token, username, store)
      .then(() => show())
      .catch((e: Error) => { if (live) setErr(e.message); });
    void load();
    const id = setInterval(() => void load(), 8000);
    return () => { live = false; clearInterval(id); };
  }, [token, username, lightningAddress, store, wallet]);

  if (!rows) return <div style={card}>Loading…</div>;

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Activity</h2>
      <p style={{ color: "#555", fontSize: 13, marginTop: 0 }}>
        This wallet's own transactions, and everything quoted against {username} — including
        quotes nobody paid, which have no transaction to show up as.
      </p>
      {err && <p style={{ ...mono, color: "crimson", fontSize: 12 }}>payment sync failed: {err}</p>}
      {!rows.length && <p style={{ color: "#666" }}>Nothing yet.</p>}
      {rows.map((r) => {
        const status = STATUS_STYLE[r.status];
        return (
          <div key={r.key}
            style={{ display: "flex", gap: 12, padding: "8px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
            <span style={{ width: 58, color: "#999", fontSize: 11, textTransform: "uppercase" }}>{r.source}</span>
            <span style={{ width: 80, color: "#666" }}>{r.label}</span>
            <span style={{ width: 90 }}>
              {r.amountSat === null ? "—" : `${r.amountSat > 0 && r.source === "wallet" ? "+" : ""}${r.amountSat} sats`}
            </span>
            <span style={{ color: status.color }} title={status.title}>{status.text}</span>
            <span style={{ marginLeft: "auto", color: "#666" }}>{new Date(r.createdAt).toLocaleString()}</span>
          </div>
        );
      })}
    </div>
  );
}
