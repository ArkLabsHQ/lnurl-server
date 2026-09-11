const SECRET_KEY = /authorization|token|secret|preimage|private|password|invoice|\bpr\b/i;
const SECRET_TEXT = /\b(authorization|token|secret|preimage|private_key|password)\s*[:=]\s*\S+/gi;
const INVOICE_TEXT = /\b(?:lnbc|lntb|lnbcrt|lnsb|lntbs)[0-9a-z]{20,}\b/gi;
const LONG_HEX = /\b[0-9a-f]{64,}\b/gi;
const MAX_TEXT = 512;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function sanitizeText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(SECRET_TEXT, "$1=[REDACTED]")
    .replace(INVOICE_TEXT, "[REDACTED_INVOICE]")
    .replace(LONG_HEX, "[REDACTED_HEX]")
    .slice(0, MAX_TEXT);
}

function redact(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (value instanceof Error) return { name: sanitizeText(value.name), message: sanitizeText(value.message) };
  if (Array.isArray(value)) return value.map((item) => redact(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]));
  }
  return typeof value === "string" ? sanitizeText(value) : value;
}

export function createLogger(sink: Pick<Console, "info" | "warn" | "error"> = console): Logger {
  const write = (level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}) => {
    sink[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...redact(fields) as object }));
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
