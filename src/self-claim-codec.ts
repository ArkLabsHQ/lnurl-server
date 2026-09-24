import { VHTLCV2ContractHandler, type VHTLC } from "@arkade-os/sdk";
import { MalformedRecordError } from "./errors.js";

export interface SerializedSelfClaimV1 {
  version: 1;
  expectedAmount: number;
  params: Record<string, string>;
}

export function serializeSelfClaim(
  script: InstanceType<typeof VHTLC.ScriptV2>,
  expectedAmount: number,
): string {
  if (!Number.isSafeInteger(expectedAmount) || expectedAmount <= 0) {
    throw new Error("self-claim expectedAmount must be a positive safe integer");
  }
  return JSON.stringify({
    version: 1,
    expectedAmount,
    params: VHTLCV2ContractHandler.serializeParams(script.options),
  } satisfies SerializedSelfClaimV1);
}

export function deserializeSelfClaim(encoded: string): {
  script: InstanceType<typeof VHTLC.ScriptV2>;
  expectedAmount: number;
} {
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw new MalformedRecordError("invalid self-claim recovery JSON"); }
  if (!value || typeof value !== "object") throw new MalformedRecordError("invalid self-claim recovery object");
  const record = value as { version?: unknown; expectedAmount?: unknown; params?: unknown };
  if (record.version !== 1) throw new MalformedRecordError("unsupported self-claim recovery version");
  if (!Number.isSafeInteger(record.expectedAmount) || Number(record.expectedAmount) <= 0) {
    throw new MalformedRecordError("invalid self-claim expectedAmount");
  }
  if (!record.params || typeof record.params !== "object" || Array.isArray(record.params)) {
    throw new MalformedRecordError("invalid self-claim parameters");
  }
  for (const value of Object.values(record.params)) {
    if (typeof value !== "string") throw new MalformedRecordError("invalid self-claim parameter value");
  }
  return {
    script: VHTLCV2ContractHandler.createScript(record.params as Record<string, string>),
    expectedAmount: Number(record.expectedAmount),
  };
}
