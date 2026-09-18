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
