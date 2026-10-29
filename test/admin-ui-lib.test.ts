import { describe, expect, it } from "vitest";
import { validateUsername } from "../src/usernames.js";
import { charsetProblem, domainProblem, normalizeDomain, usernameProblem } from "../src/admin-ui/lib.js";

describe("admin UI input checks", () => {
  it("store a domain as requests name it: no scheme, path, port or trailing dot", () => {
    expect(normalizeDomain(" https://Pay.Example.com:8443/.well-known/lnurlp/x ")).toBe("pay.example.com");
    expect(normalizeDomain("localhost:3000")).toBe("localhost");
    expect(normalizeDomain("example.org.")).toBe("example.org");
    expect(domainProblem("pay.example.com")).toBeUndefined();
    expect(domainProblem("127.0.0.1")).toBeUndefined();
    expect(domainProblem("bad_host.com")).toBeDefined();
    expect(domainProblem("")).toBeDefined();
  });

  it("refuse a character set whose bare ] would end the server's [ ] early", () => {
    expect(charsetProblem("a-z0-9._-")).toBeUndefined();
    expect(charsetProblem("a-z\\]")).toBeUndefined();
    expect(charsetProblem("a-z]+[^")).toBeDefined();
    expect(charsetProblem("")).toBeDefined();
  });

  it("predict the server's verdict on a username", () => {
    const names = ["ab", "abc", "alice", "al.ice", "al_ice-1", "averyverylongname", "al ice", "al!ce", "ünï"];
    for (const usernamePattern of ["a-z0-9._-", "a-z", "a-z0-9_-"]) {
      const rules = { usernameMinLen: 3, usernameMaxLen: 12, usernamePattern };
      for (const name of names) {
        expect(usernameProblem(name, rules) === undefined, `${name} under ${usernamePattern}`).toBe(validateUsername(name, rules));
      }
    }
    const handle = "0123456789abcdef0123456789abcdef";
    expect(usernameProblem(handle, { usernameMinLen: 1, usernameMaxLen: 64, usernamePattern: "a-z0-9" })).toMatch(/session handle/);
  });
});
