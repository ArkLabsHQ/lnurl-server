import { useEffect, useState } from "react";
import { formatUnitAmount, type PayRequest } from "@arkade-os/lnurl-client";
import { pendingConfirmations } from "./batch-verify.js";
import { payer } from "./lnurl.js";
import { CopyableQr } from "./Qr.js";
import { exportSatoraPaymentRecovery, listSatoraPayments, quoteSatoraPayment, recoverSatoraPayment, startSatoraPayment, syncSatoraPayment, type SatoraPayment } from "./satora-payment.js";

export interface SatoraDraft { request: PayRequest; amountSat: number; label: string }

const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const POLL_MS = 5_000;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const tokenAmount = (value: string) => `${formatUnitAmount(value, 6)} USDC`;
const shortError = (error: unknown) => error instanceof Error ? error.message : String(error);

function depositUri(payment: SatoraPayment): string | undefined {
  const { depositAddress, sourceAmount, expiresAt } = payment;
  if (!payment.canPay || payment.canRecover || !depositAddress || !sourceAmount || !addressPattern.test(depositAddress) || !/^[1-9]\d*$/.test(sourceAmount)) return;
  if (expiresAt !== undefined && Date.now() >= expiresAt) return;
  return `ethereum:${POLYGON_USDC}@137/transfer?address=${depositAddress}&uint256=${sourceAmount}`;
}

export function SatoraCheckout({ draft, visible, onQuoteUsed }: {
  draft?: SatoraDraft;
  visible: boolean;
  onQuoteUsed: (draft: SatoraDraft) => void;
}) {
  const [payments, setPayments] = useState<SatoraPayment[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [quote, setQuote] = useState<{ draft: SatoraDraft; sourceAmount?: string; error?: string }>();
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [syncError, setSyncError] = useState<{ key: string; text: string }>();
  const [verification, setVerification] = useState<Record<string, { settled: boolean; text: string }>>({});
  const [verifyAttempt, setVerifyAttempt] = useState(0);
  const [action, setAction] = useState<"start" | "recover" | "export">();
  const [refundAddress, setRefundAddress] = useState("");
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryTx, setRecoveryTx] = useState<{ key: string; txid: string }>();
  const payment = payments.find((p) => p.key === selectedKey) ?? payments[0];
  const { key, verify, verifyBatch, payTo, expiresAt } = payment ?? {};
  const settled = key !== undefined && verification[key]?.settled === true;
  const busy = action !== undefined;
  const restoreDeposit = payment?.recoveryKind === "deposit";
  const validRefundAddress = !restoreDeposit || (addressPattern.test(refundAddress.trim()) && !/^0x0{40}$/.test(refundAddress.trim()));
  const [expiredKey, setExpiredKey] = useState<string>();

  useEffect(() => {
    if (!key || expiresAt === undefined) return;
    const timer = setTimeout(() => setExpiredKey(key), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [key, expiresAt]);

  useEffect(() => {
    let live = true;
    void listSatoraPayments().then((saved) => {
      if (live) setPayments((current) => [...current, ...saved.filter((p) => !current.some((c) => c.key === p.key))]);
    }).catch((error: unknown) => { if (live) setHistoryError(`Could not load Satora payments. ${shortError(error)}`); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!draft) return;
    let live = true;
    setQuote(undefined);
    void quoteSatoraPayment(draft.amountSat).then(({ sourceAmount }) => {
      if (live) setQuote({ draft, sourceAmount });
    }).catch((error: unknown) => { if (live) setQuote({ draft, error: `Quote failed. ${shortError(error)}` }); });
    return () => { live = false; };
  }, [draft, quoteAttempt]);

  useEffect(() => {
    if (!key || settled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async (): Promise<void> => {
      try {
        const refreshed = await syncSatoraPayment(key);
        if (live) {
          setPayments((current) => current.map((p) => p.key === key ? refreshed : p));
          setSyncError(undefined);
        }
      } catch (error) {
        if (live) setSyncError({ key, text: `Payment check failed. ${shortError(error)}` });
      } finally {
        if (live) timer = setTimeout(() => void sync(), POLL_MS);
      }
    };
    void sync();
    return () => { live = false; clearTimeout(timer); };
  }, [key, settled]);

  useEffect(() => {
    if (!visible || !key || !verify || !payTo || settled) return;
    pendingConfirmations.add({
      key: `satora:${key}`, verifyUrl: verify, verifyBatch,
      expect: { paymentOption: "satora", paymentDestination: payTo },
      timeoutMs: 15 * 60_000,
      onSettled: (result) => {
        const settled = result.kind === "destination" && result.settled && result.paymentDestination === payTo;
        setVerification((prev) => ({ ...prev, [key]: { settled, text: settled ? "Receiver confirmed settlement" : "Receiver returned a different payment" } }));
      },
      onError: (error) => setVerification((prev) => ({ ...prev, [key]: { settled: false, text: `Settlement unconfirmed. ${error.message}` } })),
    });
  }, [visible, key, verify, verifyBatch, payTo, settled, verifyAttempt]);

  const start = async () => {
    if (!quote?.sourceAmount || quote.draft !== draft || busy) return;
    setAction("start");
    try {
      const { request, amountSat, label } = quote.draft;
      const answer = await payer.requestInvoice(request, { amountSat, paymentOption: "satora" });
      const created = await startSatoraPayment(answer, amountSat, quote.sourceAmount, label);
      setPayments((current) => [created, ...current.filter((p) => p.key !== created.key)]);
      setSelectedKey(created.key);
      onQuoteUsed(quote.draft);
    } catch (error) {
      setQuote((current) => current === quote ? { draft: quote.draft, error: `Could not prepare the deposit. ${shortError(error)}` } : current);
    } finally { setAction(undefined); }
  };

  const recover = async () => {
    if (!payment?.canRecover || !payment.recoveryKind || busy || !validRefundAddress) return;
    setAction("recover");
    setRecoveryError("");
    try {
      const txid = await recoverSatoraPayment(payment.key, restoreDeposit ? refundAddress.trim() : undefined);
      setRecoveryTx({ key: payment.key, txid });
      setRefundAddress("");
    } catch (error) { setRecoveryError(`Recovery failed. ${shortError(error)}`); }
    finally { setAction(undefined); }
  };

  const saveRecovery = async () => {
    if (!payment?.depositAddress || busy) return;
    setAction("export");
    setRecoveryError("");
    try {
      const data = await exportSatoraPaymentRecovery(payment.key);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "satora-payment-recovery.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setRecoveryError("Could not save the recovery file. Try again in this browser."); }
    finally { setAction(undefined); }
  };

  if (!visible || (!draft && !payment)) return null;
  const paymentCheckError = syncError?.key === key ? syncError?.text : undefined;
  const uri = payment && !settled && !paymentCheckError && expiredKey !== payment.key ? depositUri(payment) : undefined;
  const verificationText = key !== undefined ? verification[key]?.text : undefined;
  const activeQuote = quote?.draft === draft ? quote : undefined;

  return (
    <section aria-label="Satora checkout" style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Satora</h2>
      {draft && <div style={{ marginBottom: 16 }}>
        <p>{draft.label} · {draft.amountSat} sats</p>
        {activeQuote?.sourceAmount ? <>
          <p>Up to {tokenAmount(activeQuote.sourceAmount)} on Polygon</p>
          <button type="button" disabled={busy} onClick={() => void start()}>{action === "start" ? "Preparing…" : "Create deposit QR"}</button>
        </> : activeQuote?.error
          ? <><p role="alert">{activeQuote.error}</p><button type="button" disabled={busy} onClick={() => setQuoteAttempt((n) => n + 1)}>Refresh quote</button></>
          : <p role="status">Getting a USDC quote…</p>}
        <button type="button" style={{ marginLeft: 8 }} disabled={busy} onClick={() => onQuoteUsed(draft)}>Cancel quote</button>
      </div>}
      {historyError && <p role="alert">{historyError}</p>}
      {payments.length > 1 && (
        <label>USDC payments <select aria-label="USDC payments" value={key} disabled={busy} onChange={(event) => {
          setSelectedKey(event.target.value); setRefundAddress(""); setRecoveryError("");
        }}>
          {payments.map((p) => <option key={p.key} value={p.key}>{p.label ?? "Satora payment"} · {p.amountSat} sats</option>)}
        </select></label>
      )}
      {payment && <div>
        <h3 style={{ fontSize: 14 }}>{payment.label ?? "Satora payment"} · {payment.amountSat} sats</h3>
        <p role="status">{settled ? verificationText : payment.status}</p>
        {!settled && verificationText && <div>
          <p>{verificationText}</p>
          <button type="button" onClick={() => {
            setVerification((prev) => ({ ...prev, [payment.key]: { settled: false, text: "" } }));
            setVerifyAttempt((n) => n + 1);
          }}>Check settlement again</button>
        </div>}
        {!settled && paymentCheckError && <p role="alert">{paymentCheckError}</p>}
        {uri && <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <CopyableQr uri={uri} caption="USDC on Polygon" />
          <div style={{ minWidth: 220, flex: 1 }}>
            <p>Send exactly <strong>{tokenAmount(payment.sourceAmount!)}</strong> on Polygon.</p>
            <p style={{ overflowWrap: "anywhere" }}><code>{payment.depositAddress}</code></p>
            {expiresAt !== undefined && <p style={{ fontSize: 13 }}>Deposit before {new Date(expiresAt).toLocaleTimeString()}.</p>}
            <p style={{ fontSize: 13, color: "#555" }}>Keep this payment selected while it completes. You can resume it in this browser.</p>
          </div>
        </div>}
        {!settled && payment.canPay && expiredKey === payment.key && <p role="status">The deposit QR has expired.</p>}
        {!settled && !paymentCheckError && payment.canRecover && payment.recoveryKind && <div>
          {payment.recoveryNeedsGas && <p>Recovery requires POL in this deposit account for Polygon fees. <code>{payment.depositAddress}</code></p>}
          {restoreDeposit ? <label>Recovery wallet address on Polygon <input value={refundAddress} placeholder="0x…" autoComplete="off"
            onChange={(event) => setRefundAddress(event.target.value)} /></label>
            : <p>The swap refund goes back to this checkout’s deposit account.</p>}
          <button type="button" disabled={busy || !validRefundAddress} onClick={() => void recover()}>
            {action === "recover" ? "Recovering…" : "Recover funds"}
          </button>
        </div>}
        {payment.depositAddress && <div style={{ marginTop: 12 }}>
          <button type="button" disabled={busy} onClick={() => void saveRecovery()}>Save recovery file</button>
          <span style={{ marginLeft: 8, fontSize: 13 }}>Keep this file private. It contains the deposit keys.</span>
        </div>}
        {recoveryError && <p role="alert">{recoveryError}</p>}
        {recoveryTx?.key === payment.key && <p style={{ overflowWrap: "anywhere" }}>Recovery submitted · <code>{recoveryTx.txid}</code></p>}
      </div>}
    </section>
  );
}
