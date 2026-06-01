import { describe, it, expect } from "vitest";
import { domainFromHost, originFromRequest } from "../src/http-origin.js";

describe("domainFromHost", () => {
  it("strips port and lowercases", () => {
    expect(domainFromHost("Domain.com:3000")).toBe("domain.com");
    expect(domainFromHost("domain.com")).toBe("domain.com");
  });
  it("returns null for empty host", () => {
    expect(domainFromHost(undefined)).toBeNull();
  });
});

describe("originFromRequest", () => {
  it("uses protocol and host from the (trust-proxy-resolved) request", () => {
    const req = { protocol: "https", get: (h: string) => (h.toLowerCase() === "host" ? "domain.com" : undefined) };
    expect(originFromRequest(req as never)).toBe("https://domain.com");
  });
});
