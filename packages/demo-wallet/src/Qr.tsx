import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { BIP21 } from "@arkade-os/sdk";

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

export type ReceiveForm = "lightning" | "unified";

/**
 * The payment URI for one form.
 *
 * The unified form is built with the SDK's `BIP21` rather than by hand, so the
 * Arkade extension parameter is spelled the way every Arkade wallet already
 * parses it. `lightning` carries the LUD-16 address rather than a bolt11: this
 * page has no invoice and the address is payable at any amount, which is the
 * whole point of having one.
 */
export function receiveUri(form: ReceiveForm, addrs: {
  lightningAddress: string;
  arkadeAddress: string;
  boardingAddress: string;
}): string {
  if (form === "lightning") return `lightning:${addrs.lightningAddress}`;
  return BIP21.create({
    address: addrs.boardingAddress,
    ark: addrs.arkadeAddress,
    lightning: addrs.lightningAddress,
  });
}

const tab = (active: boolean) => ({
  background: "none",
  border: "none",
  padding: "4px 8px",
  fontSize: 12,
  cursor: "pointer",
  borderBottom: active ? "2px solid #111" : "2px solid transparent",
  fontWeight: active ? 600 : 400,
});

export function ReceiveQr({ lightningAddress, arkadeAddress, boardingAddress }: {
  lightningAddress: string;
  arkadeAddress: string;
  boardingAddress: string;
}) {
  const [form, setForm] = useState<ReceiveForm>("lightning");
  const uri = receiveUri(form, { lightningAddress, arkadeAddress, boardingAddress });
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
        <button style={tab(form === "lightning")} onClick={() => setForm("lightning")}>Lightning address</button>
        <button style={tab(form === "unified")} onClick={() => setForm("unified")}>Unified (BIP321)</button>
      </div>
      <Qr text={uri} />
      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "#666", fontSize: 12 }}>
          {form === "lightning" ? "Lightning only" : "on-chain · Arkade · Lightning"}
        </span>
        <button
          style={{ ...tab(false), border: "1px solid #bbb", borderRadius: 6, padding: "2px 8px" }}
          onClick={() => { void navigator.clipboard.writeText(uri); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
        >{copied ? "copied" : "copy URI"}</button>
      </div>
    </div>
  );
}
