import { createServer } from "./server.js";

const port = Number(process.env.PORT) || 3000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const minSendable = Number(process.env.MIN_SENDABLE) || 1_000;
const maxSendable = Number(process.env.MAX_SENDABLE) || 100_000_000_000;
const invoiceTimeoutMs = Number(process.env.INVOICE_TIMEOUT_MS) || 30_000;

const app = createServer({
  port,
  baseUrl,
  minSendable,
  maxSendable,
  invoiceTimeoutMs,
});

app.listen(port, () => {
  console.log(`arkade-lnurl listening on ${baseUrl}`);
  console.log(`  min: ${minSendable} msat, max: ${maxSendable} msat`);
  console.log(`  invoice timeout: ${invoiceTimeoutMs}ms`);
});
