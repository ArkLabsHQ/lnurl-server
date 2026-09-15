import { describe, it, expect } from "vitest";
import {
  RAIL_IDS,
  advertisedRailOptions,
  describeServerRails,
  effectiveRails,
  isRailId,
  normalizeDisabledRails,
  parseDisabledRails,
  type ServerRailCaps,
} from "../src/rails.js";

const FULL: ServerRailCaps = {
  offlineSwapCreator: true,
  discoveryReady: true,
  arkServerUrl: "https://ark.invalid",
  covenantDestinations: true,
};
const BARE: ServerRailCaps = {
  offlineSwapCreator: false,
  discoveryReady: false,
  covenantDestinations: false,
};
const IDENTITY = { arkadeAddress: "ark1xyz", claimPublicKey: "02" + "ab".repeat(32), disabledRails: [] as string[] };

describe("rail registry", () => {
  it("names every rail exactly once", () => {
    expect(RAIL_IDS).toEqual(["interactive-lightning", "offline-swap", "arkade", "covenant"]);
    expect(new Set(RAIL_IDS).size).toBe(RAIL_IDS.length);
  });

  it("rejects the reserved onchain id until it is implemented", () => {
    expect(isRailId("onchain")).toBe(false);
    expect(() => normalizeDisabledRails(["onchain"])).toThrow(/unknown rail id/);
  });

  it("normalizes policy lists (dedupes, rejects unknowns and non-arrays)", () => {
    expect(normalizeDisabledRails(["arkade", "arkade"])).toEqual(["arkade"]);
    expect(() => normalizeDisabledRails("arkade")).toThrow(/must be an array/);
    expect(() => normalizeDisabledRails(["nope"])).toThrow(/unknown rail id/);
  });

  it("parses the DB column leniently (never fatal on corrupt rows)", () => {
    expect(parseDisabledRails('["arkade","covenant"]')).toEqual(["arkade", "covenant"]);
    expect(parseDisabledRails("not json")).toEqual([]);
    expect(parseDisabledRails('["arkade","onchain"]')).toEqual(["arkade"]);
    expect(parseDisabledRails(null)).toEqual([]);
  });
});

describe("describeServerRails", () => {
  it("reports interactive ready and everything else by wiring", () => {
    const states = new Map(describeServerRails(BARE).map((s) => [s.id, s]));
    expect(states.get("interactive-lightning")).toMatchObject({ configured: true, ready: true });
    expect(states.get("offline-swap")).toMatchObject({ configured: false, ready: false });
    expect(states.get("offline-swap")?.reason).toMatch(/not configured/);
    expect(states.get("arkade")?.reason).toMatch(/ARK_SERVER_URL/);
    expect(states.get("covenant")?.reason).toMatch(/OFFLINE_COVENANT_DESTINATIONS/);
  });

  it("marks the offline swap unready with the discovery reason", () => {
    const states = new Map(
      describeServerRails({ ...FULL, discoveryReady: false, discoveryReason: "registry down" }).map((s) => [s.id, s]),
    );
    expect(states.get("offline-swap")).toMatchObject({ configured: true, ready: false });
    expect(states.get("offline-swap")?.reason).toMatch(/registry down/);
  });
});

describe("effectiveRails", () => {
  it("serves everything when wired with an identity and empty policy", () => {
    const states = effectiveRails(IDENTITY, FULL);
    expect(states.filter((s) => s.available).map((s) => s.id)).toEqual([...RAIL_IDS]);
  });

  it("needs an Arkade identity for the offline, arkade and covenant rails", () => {
    const states = new Map(
      effectiveRails({ arkadeAddress: null, claimPublicKey: null, disabledRails: [] }, FULL).map((s) => [s.id, s]),
    );
    expect(states.get("interactive-lightning")?.available).toBe(true);
    for (const id of ["offline-swap", "arkade", "covenant"] as const) {
      expect(states.get(id)?.available).toBe(false);
      expect(states.get(id)?.reason).toMatch(/no registered Arkade identity/);
    }
  });

  it("honors per-address disables with an explicit reason", () => {
    const states = new Map(
      effectiveRails({ ...IDENTITY, disabledRails: ["arkade", "offline-swap"] }, FULL).map((s) => [s.id, s]),
    );
    expect(states.get("arkade")).toMatchObject({ enabled: false, available: false, reason: "disabled for this address" });
    expect(states.get("offline-swap")).toMatchObject({ enabled: false, available: false });
    expect(states.get("interactive-lightning")?.available).toBe(true);
    expect(states.get("covenant")?.available).toBe(true);
  });

  it("reports unready discovery on the offline rail", () => {
    const states = new Map(
      effectiveRails(IDENTITY, { ...FULL, discoveryReady: false, discoveryReason: "no cards" }).map((s) => [s.id, s]),
    );
    expect(states.get("offline-swap")).toMatchObject({ enabled: true, available: false });
    expect(states.get("offline-swap")?.reason).toMatch(/no cards/);
  });
});

describe("advertisedRailOptions", () => {
  it("keeps the historical identity-only rule without server caps", () => {
    expect(advertisedRailOptions(IDENTITY)).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
    expect(advertisedRailOptions({ arkadeAddress: null, claimPublicKey: null, disabledRails: [] })).toEqual([]);
  });

  it("stays pure LUD-06 without an arkade rail even when lightning serves", () => {
    expect(advertisedRailOptions({ arkadeAddress: null, claimPublicKey: null, disabledRails: [] }, FULL)).toEqual([]);
  });

  it("omits a disabled arkade rail from the payRequest", () => {
    expect(advertisedRailOptions({ ...IDENTITY, disabledRails: ["arkade"] }, FULL)).toEqual([]);
  });

  it("offers arkade alone when both lightning rails are disabled", () => {
    expect(
      advertisedRailOptions({ ...IDENTITY, disabledRails: ["interactive-lightning", "offline-swap"] }, FULL),
    ).toEqual([{ id: "arkade", type: "arkade" }]);
  });
});