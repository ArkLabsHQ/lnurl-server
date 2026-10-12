import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { arkade, ArkAddress, CSVMultisigTapscript, ConditionMultisigTapscript, MultisigTapscript, VtxoScript } from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { compileCovenantV3, type CovenantProgramInput } from "../src/covenant/program.js";
import { FORWARDING_ARTIFACT } from "../src/covenant/forwarding-artifact.js";

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const serverPubkey = key(3);
const userPubkey = key(4);
const emulatorPubkey = secp256k1.getPublicKey(new Uint8Array(32).fill(5), true);
const staticAddress = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [key(9), serverPubkey] }).script,
]).address("tark", serverPubkey).encode();
const input = (over: Partial<CovenantProgramInput> = {}): CovenantProgramInput => ({
  staticAddress, serverPubkey, userPubkey, emulatorPubkey,
  preimage: new Uint8Array(32).fill(7), recoveryDelaySeconds: 4096, ...over,
});
const names = ["sweep", "collaborative", "recovery", "renew"];

describe("compiler forwarding program", () => {
  it("loads only the committed compiler artifact fields", () => {
    const artifact = JSON.parse(readFileSync(resolve("contracts/forwarding.json"), "utf8"));
    expect(FORWARDING_ARTIFACT).toEqual({
      contractName: artifact.contractName,
      constructorInputs: artifact.constructorInputs,
      functions: artifact.functions,
    });
    expect(artifact.compiler).toMatchObject({ name: "arkadec", version: "0.1.0" });
    expect(artifact.source.entry).toBe("forwarding.ark");
    expect(artifact).not.toHaveProperty("updatedAt");
  });

  it("constructs four named paths in their published leaf order with correct control blocks", () => {
    const compiled = compileCovenantV3(input());
    expect(compiled.compiled.map((fn) => fn.name)).toEqual(names);
    expect(compiled.scripts).toHaveLength(4);
    for (const [index, name] of names.entries()) {
      const fn = compiled.functionByName(name)!;
      expect(fn.leafScript).toEqual(compiled.scripts[index]);
      expect(fn.tapLeafScript).toEqual(compiled.leaves[index]);
    }
  });

  it("requires the preimage and operator plus the sweep covenant emulator", () => {
    const sweep = compileCovenantV3(input()).functionByName("sweep")!;
    const closure = ConditionMultisigTapscript.decode(sweep.leafScript);
    expect(closure.params.conditionScript).toEqual(
      arkade.ArkadeScript.encode(["HASH160", ripemd160(sha256(input().preimage)), "EQUAL"]),
    );
    expect(closure.params.pubkeys).toEqual([
      serverPubkey, arkade.computeArkadeScriptPublicKey(emulatorPubkey, sweep.arkadeScript!),
    ]);
    expect(sweep.def.tapscript.witness).toEqual(["preimage"]);
    expect(arkade.ArkadeScript.decode(sweep.arkadeScript!)).toEqual([
      ArkAddress.decode(staticAddress).pkScript.subarray(2), "PUSHCURRENTINPUTINDEX", "DUP", 4, 0,
      "TUNNEL", "VERIFY", "DUP", "INSPECTOUTPUTSCRIPTPUBKEY", "NIP", 1, "EQUALVERIFY",
      "DUP", "INSPECTOUTPUTSCRIPTPUBKEY", "DROP", "ROT", "EQUALVERIFY", "DUP",
      "INSPECTOUTPUTVALUE", "SWAP", "INSPECTINPUTVALUE", "GREATERTHANOREQUAL",
    ]);
  });

  it("keeps user recovery and collaboration independent of the preimage", () => {
    const a = compileCovenantV3(input());
    const b = compileCovenantV3(input({ preimage: new Uint8Array(32).fill(8) }));
    expect(a.pkScript).not.toEqual(b.pkScript);
    expect(a.functionByName("collaborative")!.leafScript).toEqual(
      MultisigTapscript.encode({ pubkeys: [userPubkey, serverPubkey] }).script,
    );
    expect(a.functionByName("recovery")!.leafScript).toEqual(
      CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 4096n }, pubkeys: [userPubkey] }).script,
    );
    for (const name of ["collaborative", "recovery", "renew"])
      expect(a.functionByName(name)!.leafScript).toEqual(b.functionByName(name)!.leafScript);
  });

  it("makes renewal permissionless through operator and emulator while preserving everything", () => {
    const renew = compileCovenantV3(input()).functionByName("renew")!;
    expect(renew.def.inputs ?? []).toEqual([]);
    expect(renew.def.tapscript.witness ?? []).toEqual([]);
    expect(renew.signerKeys).toEqual([serverPubkey]);
    const asm = arkade.ArkadeScript.decode(renew.arkadeScript!);
    const bytes = (value: string) => new TextEncoder().encode(value);
    expect(asm).toEqual([
      bytes("type"), "INSPECTINTENTMESSAGE", "VERIFY", bytes("register"), "EQUALVERIFY",
      bytes("onchain_output_indexes"), "INSPECTINTENTMESSAGE", "VERIFY", bytes("[]"), "EQUALVERIFY",
      bytes("cosigners_public_keys.1"), "INSPECTINTENTMESSAGE", "NIP", "NOT", "VERIFY",
      "PUSHCURRENTINPUTINDEX", 1, "SUB", 7, 0, "TUNNEL",
    ]);
    expect(MultisigTapscript.decode(renew.leafScript).params.pubkeys).toEqual([
      serverPubkey, arkade.computeArkadeScriptPublicKey(emulatorPubkey, renew.arkadeScript!),
    ]);
  });

  it("normalizes compressed signing keys without changing the program", () => {
    const expanded = compileCovenantV3(input({
      userPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(4), true),
      serverPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(3), true),
    }));
    expect(expanded.pkScript).toEqual(compileCovenantV3(input()).pkScript);
  });

  it("preserves raw seconds sequences across the BIP68 range", () => {
    for (const recoveryDelaySeconds of [512, 4096, 86_016, 33_553_920]) {
      const compiled = compileCovenantV3(input({ recoveryDelaySeconds }));
      expect(compiled.functionByName("recovery")!.leafScript).toEqual(
        CSVMultisigTapscript.encode({
          timelock: { type: "seconds", value: BigInt(recoveryDelaySeconds) }, pubkeys: [userPubkey],
        }).script,
      );
      expect(compiled.functionByName("sweep")!.arkadeScript).toEqual(
        compileCovenantV3(input()).functionByName("sweep")!.arkadeScript,
      );
    }
  });

  it("commits the destination, all signer keys and the recovery delay to the address", () => {
    const a = compileCovenantV3(input());
    expect(a.pkScript).toEqual(compileCovenantV3(input()).pkScript);
    const destination = new VtxoScript([
      MultisigTapscript.encode({ pubkeys: [key(10), serverPubkey] }).script,
    ]).address("tark", serverPubkey).encode();
    for (const over of [
      { staticAddress: destination }, { userPubkey: key(10) }, { serverPubkey: key(10) },
      { emulatorPubkey: secp256k1.getPublicKey(new Uint8Array(32).fill(10), true) },
      { recoveryDelaySeconds: 8192 },
    ]) expect(compileCovenantV3(input(over)).pkScript).not.toEqual(a.pkScript);
  });

  it("rejects invalid preimages, signing keys and non-BIP68 recovery delays", () => {
    expect(() => compileCovenantV3(input({ preimage: new Uint8Array(31) }))).toThrow(/preimage/);
    for (const name of ["userPubkey", "serverPubkey", "emulatorPubkey"] as const)
      expect(() => compileCovenantV3(input({ [name]: new Uint8Array(31) }))).toThrow(/key/);
    for (const recoveryDelaySeconds of [0, -512, 4097, 33_554_432])
      expect(() => compileCovenantV3(input({ recoveryDelaySeconds }))).toThrow();
  });
});
