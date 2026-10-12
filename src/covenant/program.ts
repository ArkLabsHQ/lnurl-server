import { arkade, ArkAddress, sequenceToTimelock, timelockToSequence } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { FORWARDING_ARTIFACT } from "./forwarding-artifact.js";

export interface CovenantProgramInput {
  staticAddress: string;
  userPubkey: Uint8Array;
  serverPubkey: Uint8Array;
  emulatorPubkey: Uint8Array;
  preimage: Uint8Array;
  recoveryDelaySeconds: number;
}

const rawProgram = arkade.programFromArtifact(FORWARDING_ARTIFACT);
const program = {
  ...rawProgram,
  functions: Object.fromEntries(["sweep", "collaborative", "recovery", "renew"].map((name) => [name, rawProgram.functions[name]])),
};

const xOnly = (key: Uint8Array): Uint8Array => {
  if (key.length === 32) return key;
  if (key.length === 33) return key.subarray(1);
  throw new Error(`expected a 32- or 33-byte key, got ${key.length} bytes`);
};

export function compileCovenantV3(input: CovenantProgramInput): InstanceType<typeof arkade.ArkadeProgramScript> {
  if (input.preimage.length !== 32) throw new Error(`preimage must be 32 bytes, got ${input.preimage.length}`);
  if (!Number.isInteger(input.recoveryDelaySeconds) || input.recoveryDelaySeconds <= 0 || input.recoveryDelaySeconds % 512 !== 0) {
    throw new Error("recoveryDelaySeconds must be a positive multiple of 512");
  }
  const userKey = xOnly(input.userPubkey);
  const serverKey = xOnly(input.serverPubkey);
  xOnly(input.emulatorPubkey);
  const emulatorKey = input.emulatorPubkey.length === 33
    ? input.emulatorPubkey : Uint8Array.from([0x02, ...input.emulatorPubkey]);
  const destination = ArkAddress.decode(input.staticAddress).pkScript;
  if (destination.length !== 34 || destination[0] !== 0x51 || destination[1] !== 0x20)
    throw new Error("destination must be a P2TR pkScript");
  const recoverySequence = timelockToSequence({ type: "seconds", value: BigInt(input.recoveryDelaySeconds) });
  // The SDK bridge interprets a symbolic CSV operand as blocks; decode the bound raw sequence instead.
  const recovery = {
    ...program.functions.recovery,
    tapscript: { ...program.functions.recovery.tapscript, csv: sequenceToTimelock(recoverySequence) },
  };
  return new arkade.ArkadeProgramScript({ ...program, functions: { ...program.functions, recovery } }, {
    destinationKey: destination.subarray(2),
    userKey,
    preimageHash: ripemd160(sha256(input.preimage)),
    recoverySequence: BigInt(recoverySequence),
    server: serverKey,
  }, { serverKey, userKey, emulatorKey });
}
