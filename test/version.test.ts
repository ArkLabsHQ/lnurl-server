import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";
import { openApiSpec } from "../src/http/openapi.js";
import { adminOpenApiSpec } from "../src/http/admin-openapi.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("version", () => {
  it("matches the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is what the public and admin specs report", () => {
    expect(openApiSpec.info.version).toBe(VERSION);
    expect(adminOpenApiSpec.info.version).toBe(VERSION);
  });
});
