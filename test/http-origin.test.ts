import { describe, it, expect } from "vitest";
import { domainFromHost } from "../src/http-origin.js";

describe("domainFromHost", () => {
  it("strips port and lowercases", () => {
    expect(domainFromHost("Domain.com:3000")).toBe("domain.com");
    expect(domainFromHost("domain.com")).toBe("domain.com");
  });
  it("returns null for empty host", () => {
    expect(domainFromHost(undefined)).toBeNull();
  });
  it("handles bracketed IPv6 with port", () => {
    expect(domainFromHost("[::1]:3000")).toBe("::1");
  });
  it("handles bracketed IPv6 without port", () => {
    expect(domainFromHost("[2001:db8::1]")).toBe("2001:db8::1");
  });
  it("returns null for malformed bracketed IPv6", () => {
    expect(domainFromHost("[::1")).toBeNull();
  });
});
