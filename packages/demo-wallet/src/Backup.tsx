import { useState } from "react";
import { loadMnemonic, restoreMnemonic, wipeWallet } from "./wallet.js";

const card = { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 16 } as const;
const mono = { fontFamily: "ui-monospace, monospace", fontSize: 13, wordBreak: "break-all" } as const;
const btn = { padding: "8px 14px", borderRadius: 6, border: "1px solid #bbb", background: "#fafafa", cursor: "pointer" } as const;
const danger = { ...btn, borderColor: "#c33", color: "#c33" } as const;
const field = { padding: 8, borderRadius: 6, border: "1px solid #bbb", width: "100%", boxSizing: "border-box" } as const;
const section = { borderTop: "1px solid #eee", marginTop: 16, paddingTop: 16 } as const;
const note = { color: "#555", fontSize: 13, marginTop: 0 } as const;

export interface BackupProps {
  /** The phrase is already stored; this hands back the one that was adopted so
   *  the app can re-open the wallet without reading storage again. */
  onRestored: (mnemonic: string) => void;
  /** The keys are gone by the time this fires; the app decides what to show. */
  onReset: () => void;
}

/**
 * Reveal, restore and erase for the wallet's recovery phrase.
 *
 * The phrase is read from storage inside the reveal handler rather than taken
 * as a prop, so it never sits in React state — or in a parent's — until someone
 * asks for it on a page that is usually being screen-shared.
 */
export function Backup({ onRestored, onReset }: BackupProps) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [everRevealed, setEverRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmWord, setConfirmWord] = useState("");

  const stored = loadMnemonic();

  const reveal = () => {
    setPhrase(loadMnemonic());
    setEverRevealed(true);
  };

  const copy = () => {
    if (!phrase) return;
    void navigator.clipboard.writeText(phrase);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  /** Erase, or erase and adopt the pasted phrase. The import is validated BEFORE
   *  anything is wiped: a typo must not cost the caller the wallet they had. */
  const replace = async () => {
    const wants = draft.trim();
    if (wants) {
      const checked = restoreMnemonic(draft);
      if (!checked.ok) {
        setResult({ ok: false, text: checked.error });
        return;
      }
      setResult({ ok: true, text: "Phrase adopted — re-opening the wallet." });
      setDraft("");
      setPhrase(null);
      setConfirming(false);
      setConfirmWord("");
      onRestored(checked.mnemonic);
      return;
    }
    await wipeWallet();
    setPhrase(null);
    setConfirming(false);
    setConfirmWord("");
    onReset();
  };

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Recovery phrase</h2>
      <p style={note}>
        These words are the only copy of this wallet's key. They live in this browser and
        nowhere else: clearing site data, or erasing below, destroys them and every sat
        they hold. Nobody — not this page, not the LNURL server — can recover them for you.
      </p>

      {!stored ? (
        <p style={{ color: "#666", fontSize: 13 }}>No phrase stored in this browser yet.</p>
      ) : phrase ? (
        <>
          <div style={{ ...mono, border: "1px solid #ddd", borderRadius: 6, padding: 12, background: "#fafafa", marginBottom: 8 }}>
            {phrase}
          </div>
          <button style={btn} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          <button style={{ ...btn, marginLeft: 8 }} onClick={() => setPhrase(null)}>Hide</button>
        </>
      ) : (
        <>
          <button style={btn} onClick={reveal}>Reveal phrase</button>
          <span style={{ color: "#666", fontSize: 12, marginLeft: 8 }}>hidden until you ask</span>
        </>
      )}

      {/* One destructive door, not two. Restoring and erasing both end this
          wallet and start another; offering "restore" as its own routine
          setting invited it to be used as if it were one, with the current key
          discarded as a side effect nobody was asked about. */}
      <div style={section}>
        <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>Replace this wallet</h3>
        {!confirming ? (
          <>
            <p style={note}>
              Ends this wallet and starts another — either a fresh key, or one you import
              from a phrase. Either way the key here is gone, and with it the claimed
              Lightning address, which belongs to the key that registered it.
            </p>
            <button style={danger} onClick={() => setConfirming(true)}>Erase wallet…</button>
          </>
        ) : (
          <>
            <p style={{ ...note, color: "#c33" }}>
              Everything this wallet holds is unrecoverable without the phrase.
              {!everRevealed && " You have not revealed it in this session."}
              {" "}Type ERASE to confirm.
            </p>
            <input
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              placeholder="ERASE"
              style={{ ...field, maxWidth: 200, marginBottom: 8 }}
            />
            <p style={note}>
              Leave the box below empty to start fresh, or paste twelve words to import that
              wallet instead.
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="twelve words separated by spaces (optional)"
              style={{ ...field, ...mono, marginBottom: 8, resize: "vertical" }}
            />
            <div>
              <button
                style={danger}
                disabled={confirmWord.trim().toUpperCase() !== "ERASE"}
                onClick={replace}
              >{draft.trim() ? "Erase and import" : "Erase wallet"}</button>
              <button
                style={{ ...btn, marginLeft: 8 }}
                onClick={() => { setConfirming(false); setConfirmWord(""); setDraft(""); setResult(null); }}
              >Cancel</button>
            </div>
            {result && (
              <p style={{ ...mono, color: result.ok ? "#16834b" : "crimson" }}>{result.text}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
