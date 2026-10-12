import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { fakeFixedFloat, type FakeFf } from "./helpers/fake-fixedfloat.js";

let ff: FakeFf | undefined;
afterEach(async () => { await ff?.close(); ff = undefined; });

const post = (f: FakeFf, method: string, body: string, sign: string) =>
  fetch(`${f.baseUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-API-KEY": f.apiKey, "X-API-SIGN": sign },
    body,
  }).then(async (res) => ({ status: res.status, json: (await res.json()) as { code: number; msg: string; data: unknown } }));

const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

describe("fake FixedFloat", () => {
  it("rejects a request whose X-API-SIGN does not match the body", async () => {
    ff = await fakeFixedFloat();
    const res = await post(ff, "ccies", "{}", hmac("not-the-secret", "{}"));
    expect(res.json.code).not.toBe(0);
    expect(ff.calls).toEqual([]);

    const good = await post(ff, "ccies", "{}", hmac(ff.secret, "{}"));
    expect(good.json.code).toBe(0);
    expect(ff.calls.map((c) => c.method)).toEqual(["ccies"]);
  });

  it("signs over the exact body bytes, so a re-serialised body fails", async () => {
    ff = await fakeFixedFloat();
    const signed = JSON.stringify({ id: "AB12CD", token: "t" });
    const sent = JSON.stringify({ token: "t", id: "AB12CD" });
    const res = await post(ff, "order", sent, hmac(ff.secret, signed));
    expect(res.json.code).not.toBe(0);
    expect(ff.calls).toEqual([]);
  });

  it("serves rates XML with the currency code appended to minamount, as ff.io does", async () => {
    ff = await fakeFixedFloat();
    const xml = await fetch(ff.ratesUrl).then((r) => r.text());
    expect(xml).toMatch(/<from>USDTARBITRUM<\/from>\s*<to>BTCLN<\/to>/);
    expect(xml).toContain("<minamount>2.3959966639 USDTARBITRUM</minamount>");
    expect(xml).toContain("<tofee>0.0000016800 BTCLN</tofee>");
  });
});
