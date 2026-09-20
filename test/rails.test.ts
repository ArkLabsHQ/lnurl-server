import { describe, it, expect } from "vitest";
import {
  RAIL_IDS,
  advertisedRailOptions,
  describeServerRails,
  effectiveRails,
  isRailId,
  normalizeDisabledRails,
  optionBounds,
  parseDisabledRails,
  railBounds,
  withVtxoFloors,
  type Bounds,
  type ServerRailCaps,
} from "../src/rails.js";

const BASE: Bounds = { min: 1_000, max: 100_000_000 };

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
    expect(RAIL_IDS).toEqual(["interactive-lightning", "offline-swap", "arkade", "covenant", "onchain"]);
    expect(new Set(RAIL_IDS).size).toBe(RAIL_IDS.length);
  });

  it("accepts onchain, which is no longer reserved", () => {
    expect(isRailId("onchain")).toBe(true);
    expect(normalizeDisabledRails(["onchain"])).toEqual(["onchain"]);
  });

  it("normalizes policy lists (dedupes, rejects unknowns and non-arrays)", () => {
    expect(normalizeDisabledRails(["arkade", "arkade"])).toEqual(["arkade"]);
    expect(() => normalizeDisabledRails("arkade")).toThrow(/must be an array/);
    expect(() => normalizeDisabledRails(["nope"])).toThrow(/unknown rail id/);
  });

  it("parses the DB column leniently (never fatal on corrupt rows)", () => {
    expect(parseDisabledRails('["arkade","covenant"]')).toEqual(["arkade", "covenant"]);
    expect(parseDisabledRails("not json")).toEqual([]);
    expect(parseDisabledRails('["arkade","onchain"]')).toEqual(["arkade", "onchain"]);
    expect(parseDisabledRails('["arkade","nope"]')).toEqual(["arkade"]);
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
    // onchain keys off the boarding address rather than the Arkade identity, so
    // "fully wired" needs both. Added here and not to IDENTITY, which the
    // advertise tests share and would otherwise always offer the rail.
    const states = effectiveRails({ ...IDENTITY, boardingAddress: "tb1qboarding" }, FULL);
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

  it("emits no per-option bounds when no rail narrows the base", () => {
    expect(advertisedRailOptions(IDENTITY, FULL, BASE)).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade" },
    ]);
  });

  it("emits only the half a rail actually narrows", () => {
    const caps: ServerRailCaps = { ...FULL, limits: { arkade: { minSendable: 10_000 } } };
    expect(advertisedRailOptions(IDENTITY, caps, BASE)).toEqual([
      { id: "lightning", type: "lightning" },
      { id: "arkade", type: "arkade", minSendable: 10_000 },
    ]);
  });
});

describe("advertisedRailOptions — LUD-XX `available`", () => {
  // The spec lets a service say a rail exists but is down right now. Omitting it
  // instead tells a payer this address does not do lightning at all, which is a
  // different and wrong statement — they go elsewhere rather than retry.
  it("advertises a rail the server cannot serve right now as unavailable", () => {
    const caps: ServerRailCaps = { ...FULL, offlineSwapCreator: true, discoveryReady: false, discoveryReason: "registry down" };
    const options = advertisedRailOptions({ ...IDENTITY, disabledRails: ["interactive-lightning"] }, caps, BASE);
    expect(options.find((o) => o.id === "lightning")).toMatchObject({ id: "lightning", available: false });
  });

  // Not applicable is not the same as down: this address never registered an
  // Arkade identity, so the rail is not something it offers at all.
  it("still omits a rail this address has no identity for", () => {
    const options = advertisedRailOptions({ arkadeAddress: null, claimPublicKey: null, disabledRails: [] }, FULL, BASE);
    expect(options).toEqual([]);
  });

  it("still omits a rail the address disabled outright", () => {
    const options = advertisedRailOptions({ ...IDENTITY, disabledRails: ["arkade"] }, FULL, BASE);
    expect(options.find((o) => o.id === "arkade")).toBeUndefined();
  });

  // "If absent, assume true" — emitting it on every healthy option is noise.
  it("says nothing at all when a rail is serving", () => {
    const options = advertisedRailOptions(IDENTITY, FULL, BASE);
    for (const option of options) expect(option).not.toHaveProperty("available");
  });
});

describe("withVtxoFloors", () => {
  it("raises the VTXO-settled rails to arkd's dust", () => {
    const limits = withVtxoFloors(undefined, { dustSat: 330 });
    expect(limits?.arkade).toEqual({ minSendable: 330_000 });
    expect(limits?.covenant).toEqual({ minSendable: 330_000 });
    expect(limits?.onchain).toEqual({ minSendable: 330_000 });
  });

  it("leaves the lightning rails alone, which carry millisats natively", () => {
    const limits = withVtxoFloors({ "offline-swap": { minSendable: 400 } }, { dustSat: 330 });
    expect(limits?.["offline-swap"]).toEqual({ minSendable: 400 });
    expect(limits?.["interactive-lightning"]).toBeUndefined();
  });

  it("keeps an operator minimum that is already above dust", () => {
    const limits = withVtxoFloors({ arkade: { minSendable: 900_000, maxSendable: 5_000_000 } }, { dustSat: 330 });
    expect(limits?.arkade).toEqual({ minSendable: 900_000, maxSendable: 5_000_000 });
  });

  // The reported symptom: a 400 msat domain minimum advertised as "0.4 sats" on
  // rails that can only ever settle a whole one.
  it("never advertises a fractional sat, even with dust unknown", () => {
    const limits = withVtxoFloors({ arkade: { minSendable: 400 } }, {});
    expect(limits?.arkade?.minSendable).toBe(1_000);
  });

  it("rounds a fractional maximum down rather than up", () => {
    const limits = withVtxoFloors({ arkade: { maxSendable: 5_500 } }, { dustSat: 1 });
    expect(limits?.arkade?.maxSendable).toBe(5_000);
  });

  it("is a no-op on the lightning rails' own configured pair", () => {
    const configured = { "interactive-lightning": { minSendable: 400, maxSendable: 5_500 } };
    expect(withVtxoFloors(configured, { dustSat: 330 })?.["interactive-lightning"]).toEqual(configured["interactive-lightning"]);
  });
});

describe("withVtxoFloors — the onchain rail's economic floor", () => {
  // Dust is what arkd will accept, not what is worth accepting. A payer spending
  // a Bitcoin transaction fee of a few hundred to a few thousand sats to deliver
  // 330 is losing money to receive money, and this server has no onchain fee
  // source to work the break-even out per payment.
  it("holds the onchain rail above dust, at the configured economic floor", () => {
    const limits = withVtxoFloors(undefined, { dustSat: 330, onchainMinSat: 10_000 });
    expect(limits?.onchain).toEqual({ minSendable: 10_000_000 });
    // The other VTXO rails settle offchain and carry no such cost.
    expect(limits?.arkade).toEqual({ minSendable: 330_000 });
    expect(limits?.covenant).toEqual({ minSendable: 330_000 });
  });

  it("never drops the onchain rail below dust, whatever is configured", () => {
    const limits = withVtxoFloors(undefined, { dustSat: 330, onchainMinSat: 10 });
    expect(limits?.onchain?.minSendable).toBe(330_000);
  });

  it("keeps an operator minimum that is already higher", () => {
    const limits = withVtxoFloors({ onchain: { minSendable: 25_000_000 } }, { dustSat: 330, onchainMinSat: 10_000 });
    expect(limits?.onchain?.minSendable).toBe(25_000_000);
  });

  it("leaves the lightning rails alone", () => {
    const limits = withVtxoFloors({ "offline-swap": { minSendable: 400 } }, { dustSat: 330, onchainMinSat: 10_000 });
    expect(limits?.["offline-swap"]).toEqual({ minSendable: 400 });
  });
});

describe("railBounds", () => {
  it("narrows to the rail's own limits", () => {
    const caps: ServerRailCaps = { ...FULL, limits: { "offline-swap": { minSendable: 5_000, maxSendable: 1_000_000 } } };
    expect(railBounds("offline-swap", caps, BASE)).toEqual({ min: 5_000, max: 1_000_000 });
  });

  it("never widens past the server envelope", () => {
    const caps: ServerRailCaps = { ...FULL, limits: { arkade: { minSendable: 1, maxSendable: 999_999_999 } } };
    expect(railBounds("arkade", caps, BASE)).toEqual(BASE);
  });

  it("leaves a rail with no configured limits alone", () => {
    expect(railBounds("covenant", FULL, BASE)).toEqual(BASE);
  });
});

describe("optionBounds", () => {
  // Two rails answer "lightning" and which one serves is decided at callback
  // time, so the advertised range has to be one both can honour.
  it("intersects every available rail answering the option", () => {
    const caps: ServerRailCaps = {
      ...FULL,
      limits: {
        "interactive-lightning": { minSendable: 1_000, maxSendable: 90_000_000 },
        "offline-swap": { minSendable: 5_000, maxSendable: 1_000_000 },
      },
    };
    expect(optionBounds("lightning", IDENTITY, caps, BASE)).toEqual({ min: 5_000, max: 1_000_000 });
  });

  it("ignores a rail that cannot serve this address", () => {
    const caps: ServerRailCaps = {
      ...FULL,
      offlineSwapCreator: false,
      limits: {
        "interactive-lightning": { maxSendable: 90_000_000 },
        "offline-swap": { maxSendable: 1_000_000 },
      },
    };
    expect(optionBounds("lightning", IDENTITY, caps, BASE)).toEqual({ min: BASE.min, max: 90_000_000 });
  });

  it("returns undefined when no available rail answers the option", () => {
    const noIdentity = { arkadeAddress: null, claimPublicKey: null, disabledRails: [] };
    expect(optionBounds("arkade", noIdentity, FULL, BASE)).toBeUndefined();
  });

  // Disjoint rails intersect to min > max, which as a payRequest is malformed:
  // no amount satisfies it and every payer range check refuses everything.
  it("returns undefined rather than an impossible range when rails do not overlap", () => {
    const caps: ServerRailCaps = {
      ...FULL,
      limits: {
        "interactive-lightning": { minSendable: 50_000 },
        "offline-swap": { maxSendable: 10_000 },
      },
    };
    expect(optionBounds("lightning", IDENTITY, caps, BASE)).toBeUndefined();
  });
});