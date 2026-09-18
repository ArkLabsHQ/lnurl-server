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

  const restore = () => {
    const checked = restoreMnemonic(draft);
    if (!checked.ok) {
      setResult({ ok: false, text: checked.error });
      return;
    }
    setResult({ ok: true, text: "Phrase adopted — re-opening the wallet." });
    setDraft("");
    setPhrase(null);
    onRestored(checked.mnemonic);
  };

  const erase = () => {
    wipeWallet();
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

      <div style={section}>
        <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>Restore from a phrase</h3>
        <p style={note}>
          Adopts an existing phrase as this browser's wallet.
          {stored && " The phrase above is overwritten — reveal and copy it first if you still need it."}
          {" "}A different phrase also releases the claimed Lightning address, which belongs to the
          key that registered it.
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="twelve words separated by spaces"
          style={{ ...field, ...mono, marginBottom: 8, resize: "vertical" }}
        />
        <button style={btn} disabled={!draft.trim()} onClick={restore}>Restore wallet</button>
        {result && (
          <p style={{ ...mono, color: result.ok ? "#16834b" : "crimson" }}>{result.text}</p>
        )}
      </div>

      <div style={section}>
        <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>Erase this wallet</h3>
        {!confirming ? (
          <>
            <p style={note}>Removes the key and the claimed address from this browser, and starts over.</p>
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
            <div>
              <button
                style={danger}
                disabled={confirmWord.trim().toUpperCase() !== "ERASE"}
                onClick={erase}
              >Erase wallet</button>
              <button
                style={{ ...btn, marginLeft: 8 }}
                onClick={() => { setConfirming(false); setConfirmWord(""); }}
              >Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
