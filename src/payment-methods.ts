export interface PaymentMethod {
  type: string;
  destination: string;
}

export const MAX_PAYMENT_METHODS = 8;
export const MAX_DESTINATION_LENGTH = 512;
export const REGISTERED_OPTION_PREFIX = "registered:";

const TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Printable ASCII without whitespace: the value is echoed verbatim into public JSON and payer UIs.
const DESTINATION_PATTERN = /^[\x21-\x7e]+$/;
// Every rail id plus the types payers act on, so a method never reads as the real thing. Spelled out
// because rails.ts imports this module; test/payment-methods.test.ts fails when a rail id is missing.
const RESERVED_TYPES: ReadonlySet<string> = new Set([
  "interactive-lightning", "offline-swap", "arkade", "covenant", "onchain", "fixedfloat", "registered",
  "lightning", "eip155", "solana", "tron",
]);

export function isReservedMethodType(type: string): boolean {
  return RESERVED_TYPES.has(type);
}

function entryProblem(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "must be an object";
  const fields = entry as Record<string, unknown>;
  if (Object.keys(fields).some((key) => key !== "type" && key !== "destination")) return "may have only type and destination";
  const { type, destination } = fields;
  if (typeof type !== "string" || !TYPE_PATTERN.test(type)) {
    return "type must be 1-32 lowercase letters, digits or hyphens, starting with a letter";
  }
  if (isReservedMethodType(type)) return `type ${type} is reserved`;
  if (typeof destination !== "string" || destination.length > MAX_DESTINATION_LENGTH || !DESTINATION_PATTERN.test(destination)) {
    return `destination must be 1-${MAX_DESTINATION_LENGTH} printable ASCII characters without whitespace`;
  }
  return null;
}

/** Validate a caller-supplied method list; throws an Error whose message is safe to show the caller. */
export function normalizePaymentMethods(value: unknown): PaymentMethod[] {
  if (!Array.isArray(value)) throw new Error("methods must be an array");
  if (value.length > MAX_PAYMENT_METHODS) throw new Error(`methods may have at most ${MAX_PAYMENT_METHODS} entries`);
  const out: PaymentMethod[] = [];
  for (const [i, entry] of value.entries()) {
    const problem = entryProblem(entry);
    if (problem) throw new Error(`methods[${i}] ${problem}`);
    const { type, destination } = entry as PaymentMethod;
    if (out.some((method) => method.type === type)) throw new Error(`methods[${i}] duplicates type ${type}`);
    out.push({ type, destination });
  }
  return out;
}

/** Parse the DB JSON column; entries the bind would refuse, and repeats of a type, are dropped, never fatal. */
export function parsePaymentMethods(value: unknown): PaymentMethod[] {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((entry): entry is PaymentMethod => {
      if (entryProblem(entry) !== null || seen.has(entry.type)) return false;
      seen.add(entry.type);
      return true;
    });
  } catch {
    return [];
  }
}

export function serializePaymentMethods(methods: readonly PaymentMethod[]): string {
  return JSON.stringify(methods.map(({ type, destination }) => ({ type, destination })));
}
