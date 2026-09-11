const SECRET_KEY = /authorization|token|secret|preimage|private|password|invoice|\bpr\b/i;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

function redact(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (depth > 5) return "[TRUNCATED]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => redact(item, key, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey, depth + 1)]));
  }
  return value;
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
