import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string>("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { width: size, margin: 1 })
      .then((url) => { if (live) setSrc(url); })
      .catch(() => { if (live) setSrc(""); });
    return () => { live = false; };
  }, [text, size]);
  if (!src) return <div style={{ width: size, height: size, background: "#f3f4f6", borderRadius: 8 }} />;
  return <img src={src} width={size} height={size} alt="QR code" style={{ borderRadius: 8, display: "block" }} />;
}

/**
 * The LUD-16 address, not a bolt11: this page holds no invoice, and an address
 * is payable at any amount on any rail it advertises — which is the whole point
 * of receiving through one. A unified BIP321 URI would have to name the Arkade
 * and boarding addresses, and those are deliberately not part of this wallet's
 * receive surface; a payer who wants a specific rail asks the address for it
 * and scans what comes back.
 */
export const receiveUri = (lightningAddress: string): string => `lightning:${lightningAddress}`;

const chip = {
  background: "none",
  border: "1px solid #bbb",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 12,
  cursor: "pointer",
} as const;

export function CopyableQr({ uri, caption }: { uri: string; caption: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <Qr text={uri} />
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#666", fontSize: 12 }}>{caption}</span>
        <button
          style={chip}
          onClick={() => { void navigator.clipboard.writeText(uri); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        >{copied ? "copied" : "copy URI"}</button>
      </div>
    </div>
  );
}

export function ReceiveQr({ lightningAddress }: { lightningAddress: string }) {
  return <CopyableQr uri={receiveUri(lightningAddress)} caption="Lightning address" />;
}
