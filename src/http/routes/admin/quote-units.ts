import { Router } from "express";
import { QuoteUnitError } from "../../../price-feed.js";
import { BadRequest, Conflict, NotFound, ServiceUnavailable } from "../../errors.js";
import type { AdminDeps } from "../../admin-context.js";

/** LUD-XX quote units: list, add or replace, remove, and read a feed before saving it. */
export function adminQuoteUnitRoutes({ quotes }: AdminDeps): Router {
  const r = Router();
  const need = () => {
    if (!quotes) throw new ServiceUnavailable("payment quotes are not configured", { code: "quotes_unavailable" });
    return quotes;
  };
  // A bad field is the operator's input; a feed that will not answer is too, since they typed its URL.
  const invalid = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof QuoteUnitError) throw new BadRequest(error.message, { code: "invalid_quote_unit", details: [error.field] });
      throw new BadRequest(error instanceof Error ? error.message : String(error), { code: "feed_unreadable" });
    }
  };
  const body = (raw: unknown) => {
    const b = (raw ?? {}) as { decimals?: unknown; feedUrl?: unknown; pricePath?: unknown };
    if (typeof b.feedUrl !== "string") throw new BadRequest("feedUrl must be a string", { code: "invalid_quote_unit", details: ["feedUrl"] });
    if (b.pricePath !== undefined && typeof b.pricePath !== "string") throw new BadRequest("pricePath must be a string", { code: "invalid_quote_unit", details: ["pricePath"] });
    return { decimals: Number(b.decimals), feedUrl: b.feedUrl, pricePath: b.pricePath === "" ? undefined : b.pricePath };
  };

  r.get("/quote-units", (_req, res) => res.json(need().list()));
  r.post("/quote-units/refresh", async (_req, res) => {
    const q = need();
    await q.refresh();
    res.json(q.list());
  });
  r.post("/quote-units/preview", async (req, res) => {
    const q = need();
    const { feedUrl, pricePath } = body({ ...req.body, decimals: 0 });
    res.json({ price: await invalid(() => q.preview({ feedUrl, pricePath })) });
  });
  r.put("/quote-units/:code", async (req, res) => {
    const q = need();
    const input = body(req.body);
    res.json(await invalid(() => q.save(req.params.code, input)));
  });
  r.delete("/quote-units/:code", async (req, res) => {
    const q = need();
    const code = req.params.code.toUpperCase();
    if (await q.remove(code)) return void res.json(q.list());
    if (q.list().some((u) => u.code === code)) throw new Conflict(`${code} is set by QUOTE_UNITS; remove it from the environment instead`);
    throw new NotFound("quote unit not found");
  });
  return r;
}
