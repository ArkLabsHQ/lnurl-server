import { useState } from "react";
import {
  ARK_SERVER,
  DEFAULT_ENDPOINTS,
  EXPLORER,
  LNURL_BASE,
  LNURL_DOMAIN,
  NETWORK,
  arkServerWarning,
  clearOverrides,
  lnurlDomainFor,
  readOverrides,
  saveOverrides,
  type EndpointOverrides,
} from "./config.js";

const card = { border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 16 } as const;
const mono = { fontFamily: "ui-monospace, monospace", fontSize: 13, wordBreak: "break-all" } as const;
const btn = { padding: "8px 14px", borderRadius: 6, border: "1px solid #bbb", background: "#fafafa", cursor: "pointer" } as const;
const field = { padding: 8, borderRadius: 6, border: "1px solid #bbb", width: "100%", boxSizing: "border-box" } as const;
const section = { borderTop: "1px solid #eee", marginTop: 16, paddingTop: 16 } as const;
const note = { color: "#555", fontSize: 13, marginTop: 0 } as const;
const label = { color: "#666", fontSize: 12, marginBottom: 2 } as const;

export type Endpoints = Required<EndpointOverrides>;

export interface SettingsProps {
  /**
   * Fired after a save or a reset to defaults, with what the next load will
   * use. Endpoints are read once at import, so the page has to reload before
   * any of it takes effect.
   */
  onChanged: (endpoints: Endpoints) => void;
}

function Row({ label: name, value, tag }: { label: string; value: string; tag?: string }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "6px 0", borderTop: "1px solid #eee", fontSize: 13 }}>
      <span style={{ width: 120, color: "#666", flexShrink: 0 }}>{name}</span>
      <span style={mono}>{value}</span>
      {tag && <span style={{ marginLeft: "auto", color: "#946200", fontSize: 12, flexShrink: 0 }}>{tag}</span>}
    </div>
  );
}

/**
 * The effective endpoints, and the two that can be overridden.
 *
 * The network is not among them on purpose: see the pinned-derivation note in
 * the panel, and `IS_MAINNET` in config.ts.
 */
export function Settings({ onChanged }: SettingsProps) {
  const [lnurlBase, setLnurlBase] = useState(() => readOverrides().lnurlBase ?? DEFAULT_ENDPOINTS.lnurlBase);
  const [arkServer, setArkServer] = useState(() => readOverrides().arkServer ?? DEFAULT_ENDPOINTS.arkServer);
  const [error, setError] = useState<{ field: keyof EndpointOverrides; message: string } | null>(null);
  const [saved, setSaved] = useState<Endpoints | null>(null);

  const warning = arkServerWarning(arkServer);
  const stale = saved !== null && (saved.lnurlBase !== LNURL_BASE || saved.arkServer !== ARK_SERVER);

  const apply = (next: Endpoints) => {
    setError(null);
    setSaved(next);
    onChanged(next);
  };

  const save = () => {
    const result = saveOverrides({ lnurlBase, arkServer });
    if (!result.ok) {
      setError({ field: result.field, message: result.error });
      return;
    }
    apply({
      lnurlBase: result.overrides.lnurlBase ?? DEFAULT_ENDPOINTS.lnurlBase,
      arkServer: result.overrides.arkServer ?? DEFAULT_ENDPOINTS.arkServer,
    });
  };

  const reset = () => {
    clearOverrides();
    setLnurlBase(DEFAULT_ENDPOINTS.lnurlBase);
    setArkServer(DEFAULT_ENDPOINTS.arkServer);
    apply(DEFAULT_ENDPOINTS);
  };

  return (
    <div style={card}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Settings</h2>
      <p style={note}>What this page is talking to right now.</p>

      <Row label="Network" value={NETWORK} tag="fixed" />
      <Row label="Derivation" value="signet · BIP44 coin type 1" tag="fixed" />
      <Row label="LNURL server" value={LNURL_BASE} tag={LNURL_BASE === DEFAULT_ENDPOINTS.lnurlBase ? undefined : "overridden"} />
      <Row label="LNURL domain" value={LNURL_DOMAIN} tag="derived" />
      <Row label="Arkade Service" value={ARK_SERVER} tag={ARK_SERVER === DEFAULT_ENDPOINTS.arkServer ? undefined : "overridden"} />
      <Row label="Explorer" value={EXPLORER} />

      <div style={section}>
        <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>Why the network is not a setting</h3>
        <p style={note}>
          <code style={mono}>MnemonicIdentity</code> derives mainnet keys unless told otherwise, and the
          Arkade Service refuses a wallet whose derivation disagrees with its network — so this build
          pins signet and nothing here can move it. Deriving the network from the URL instead would give
          the same phrase a different key and a different address, with no way back to whatever the old
          one holds. Point this at another network and the wallet fails to open, loudly, which is the
          intended outcome.
        </p>
      </div>

      <div style={section}>
        <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>Override endpoints</h3>
        <p style={note}>
          Kept in this browser. Changing the Arkade Service keeps your keys but changes your Arkade
          address — it embeds the service's public key — so a Lightning address claimed earlier still
          points at the old one until it is re-bound.
        </p>

        <div style={{ marginBottom: 10 }}>
          <div style={label}>LNURL server</div>
          <input
            value={lnurlBase}
            onChange={(e) => setLnurlBase(e.target.value)}
            placeholder={DEFAULT_ENDPOINTS.lnurlBase}
            style={{ ...field, ...mono, borderColor: error?.field === "lnurlBase" ? "#c33" : "#bbb" }}
          />
          <div style={{ color: "#666", fontSize: 12, marginTop: 2 }}>
            token audience: {lnurlDomainFor(lnurlBase)}
          </div>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={label}>Arkade Service</div>
          <input
            value={arkServer}
            onChange={(e) => setArkServer(e.target.value)}
            placeholder={DEFAULT_ENDPOINTS.arkServer}
            style={{ ...field, ...mono, borderColor: error?.field === "arkServer" ? "#c33" : "#bbb" }}
          />
          {warning && <div style={{ color: "#946200", fontSize: 12, marginTop: 2 }}>{warning}</div>}
        </div>

        <button style={btn} onClick={save}>Save</button>
        <button style={{ ...btn, marginLeft: 8 }} onClick={reset}>Reset to defaults</button>

        {error && <p style={{ ...mono, color: "crimson" }}>{error.message}</p>}
        {!error && stale && (
          <p style={{ ...mono, color: "#946200" }}>Saved. Reload the page to use it.</p>
        )}
        {!error && saved !== null && !stale && (
          <p style={{ ...mono, color: "#16834b" }}>Saved.</p>
        )}
      </div>
    </div>
  );
}
