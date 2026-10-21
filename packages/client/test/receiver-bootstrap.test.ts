import { describe, expect, it, vi } from "vitest";
import type { DomainCapabilities } from "../src/addresses.js";
import type { Receiver } from "../src/wallet.js";
import { bootstrapReceiver, claimOrAdopt } from "../src/receiver-bootstrap.js";

const capabilities = (overrides: Partial<DomainCapabilities> = {}): DomainCapabilities => ({
  domain: "example.com",
  allocationModes: ["session", "self", "random"],
  usernameRules: { minLen: 1, maxLen: 20, pattern: ".*" },
  requireApiKey: false,
  ...overrides,
});

const receiver = (lightningAddress?: string): Receiver => ({
  handle: "alice",
  lightningAddress,
  lnurl: "LNURL1EXAMPLE",
  payRequest: vi.fn(),
  payments: vi.fn(),
  allocations: vi.fn(),
  sync: vi.fn(),
  upgrade: vi.fn(),
});

const facade = (owned?: Receiver, caps = capabilities()) => ({
  owned: vi.fn(async () => owned),
  capabilities: vi.fn(async () => caps),
  claim: vi.fn(async () => receiver()),
});

describe("bootstrapReceiver", () => {
  it("returns an existing named receiver without fetching capabilities or allocating", async () => {
    const held = receiver("alice@example.com");
    const rx = facade(held);

    expect(await bootstrapReceiver(rx, { autoClaimNameless: true })).toEqual({
      kind: "ready", receiver: held, claimed: false,
    });
    expect(rx.capabilities).not.toHaveBeenCalled();
    expect(rx.claim).not.toHaveBeenCalled();
    expect(held.sync).not.toHaveBeenCalled();
  });

  it("returns naming capabilities with an existing nameless receiver", async () => {
    const held = receiver();
    const caps = capabilities();
    const rx = facade(held, caps);

    expect(await bootstrapReceiver(rx)).toEqual({
      kind: "ready", receiver: held, claimed: false, capabilities: caps,
    });
    expect(rx.capabilities).toHaveBeenCalledOnce();
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("keeps a nameless receiver ready when capability discovery fails", async () => {
    const held = receiver();
    const rx = facade(held);
    const error = new Error("capabilities unavailable");
    rx.capabilities.mockRejectedValue(error);

    expect(await bootstrapReceiver(rx, { autoClaimNameless: true })).toEqual({
      kind: "ready", receiver: held, claimed: false, capabilitiesError: error,
    });
    expect(rx.claim).not.toHaveBeenCalled();
    expect(held.sync).not.toHaveBeenCalled();
  });

  it("returns onboarding without claiming by default", async () => {
    const caps = capabilities();
    const rx = facade(undefined, caps);

    expect(await bootstrapReceiver(rx)).toEqual({ kind: "onboarding", capabilities: caps });
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("claims nameless only when explicitly enabled and public session allocation is advertised", async () => {
    const caps = capabilities();
    const rx = facade(undefined, caps);
    const claimed = receiver();
    rx.claim.mockResolvedValue(claimed);
    const { signal } = new AbortController();

    expect(await bootstrapReceiver(rx, { autoClaimNameless: true, signal, refresh: true })).toEqual({
      kind: "ready", receiver: claimed, claimed: true, capabilities: caps,
    });
    expect(rx.owned).toHaveBeenCalledExactlyOnceWith({ signal, refresh: true });
    expect(rx.claim).toHaveBeenCalledExactlyOnceWith({ nameless: true }, { signal });
    expect(claimed.sync).not.toHaveBeenCalled();
  });

  it.each([
    { allocationModes: ["self", "random"], requireApiKey: false },
    { allocationModes: ["session"], requireApiKey: true },
    { allocationModes: [], requireApiKey: false },
  ])("does not auto-claim with restricted capabilities %j", async (restrictions) => {
    const caps = capabilities(restrictions);
    const rx = facade(undefined, caps);

    expect(await bootstrapReceiver(rx, { autoClaimNameless: true })).toEqual({ kind: "onboarding", capabilities: caps });
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("propagates owned lookup errors without fetching capabilities or allocating", async () => {
    const rx = facade();
    const error = new Error("owned unavailable");
    rx.owned.mockRejectedValue(error);

    await expect(bootstrapReceiver(rx, { autoClaimNameless: true })).rejects.toBe(error);
    expect(rx.capabilities).not.toHaveBeenCalled();
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("propagates capability discovery errors for an unallocated receiver without claiming", async () => {
    const rx = facade();
    const error = new Error("capabilities unavailable");
    rx.capabilities.mockRejectedValue(error);

    await expect(bootstrapReceiver(rx, { autoClaimNameless: true })).rejects.toBe(error);
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("propagates claim failure without retrying allocation", async () => {
    const rx = facade();
    const error = new Error("claim failed");
    rx.claim.mockRejectedValue(error);

    await expect(bootstrapReceiver(rx, { autoClaimNameless: true })).rejects.toBe(error);
    expect(rx.claim).toHaveBeenCalledOnce();
  });
});

describe("claimOrAdopt", () => {
  it("adopts an owned receiver without applying new claim options", async () => {
    const held = receiver();
    const rx = facade(held);

    expect(await claimOrAdopt(rx, { username: "new-name" })).toBe(held);
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("claims with the caller's options only when no receiver is owned", async () => {
    const rx = facade();
    const options = { username: "alice", claimCode: "reserved-code" };

    expect(await claimOrAdopt(rx, options)).toBe(await rx.claim.mock.results[0].value);
    expect(rx.claim).toHaveBeenCalledExactlyOnceWith(options);
  });

  it("supports a claim without options", async () => {
    const rx = facade();

    await claimOrAdopt(rx);
    expect(rx.claim).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("propagates lookup failure without allocating a replacement", async () => {
    const rx = facade();
    const error = new Error("owned unavailable");
    rx.owned.mockRejectedValue(error);

    await expect(claimOrAdopt(rx, { nameless: true })).rejects.toBe(error);
    expect(rx.claim).not.toHaveBeenCalled();
  });

  it("propagates a claim failure", async () => {
    const rx = facade();
    const error = new Error("claim unavailable");
    rx.claim.mockRejectedValue(error);

    await expect(claimOrAdopt(rx)).rejects.toBe(error);
    expect(rx.claim).toHaveBeenCalledOnce();
  });
});
