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
// Types a payer already acts on: rail types, token namespaces and the rail id. A method typed
// like one would be read as the real thing.
const RESERVED_TYPES: ReadonlySet<string> = new Set(["lightning", "arkade", "onchain", "registered", "eip155", "solana", "tron"]);

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

/** Parse the DB JSON column; entries the bind would refuse are dropped, never fatal. */
export function parsePaymentMethods(value: unknown): PaymentMethod[] {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is PaymentMethod => entryProblem(entry) === null) : [];
  } catch {
    return [];
  }
}

export function serializePaymentMethods(methods: readonly PaymentMethod[]): string {
  return JSON.stringify(methods.map(({ type, destination }) => ({ type, destination })));
}
