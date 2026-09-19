// SCRATCH PAD: why does solverLightningRail surface in Node but not in the
// browser? Runs the identical wiring in-page and reports each step, so a step
// that silently yields "no solver" is visible as itself.
import { discoverMarkets, relayTransport, solverLightningRail, solverLightningRendezvous } from "@arkade-os/swap";
import { defaultRegistryUrls } from "@arkade-os/solver-discovery";
import { getNetwork, resolveEmulatorPubkey, toXOnly } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { invoiceFactsFromBolt11 } from "../../../src/bolt11.js";
import { createLightningRail } from "./lightning.js";
import { LNURL_DOMAIN, NETWORK } from "./config.js";

const out = document.getElementById("out")!;
const say = (...parts: unknown[]) => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  out.textContent += line + "\n";
  console.log("[scratch]", line);
};
const attempt = async <T,>(label: string, fn: () => Promise<T> | T): Promise<T | undefined> => {
  try {
    const value = await fn();
    say(`OK   ${label}`);
    return value;
  } catch (err) {
    say(`FAIL ${label}: ${(err as Error).name}: ${(err as Error).message}`);
    return undefined;
  }
};

say("network:", NETWORK, "| registry:", String(defaultRegistryUrls(NETWORK)[0]));

const markets = await attempt("discoverMarkets", () =>
  discoverMarkets({ network: NETWORK, registryUrl: defaultRegistryUrls(NETWORK)[0] }));
say("markets:", markets ? markets.length : "none");
for (const m of markets ?? []) say("   pair:", (m as { pair?: string }).pair ?? "?");

const emuHex = await attempt("resolveEmulatorPubkey", () => resolveEmulatorPubkey(getNetwork(NETWORK)));
say("emulator hex chars:", emuHex ? emuHex.length : "none");
const xonly = emuHex ? toXOnly(hex.decode(emuHex), "emulator") : undefined;
say("xonly bytes:", xonly ? xonly.length : "none");

if (markets && xonly) {
  const rz = solverLightningRendezvous(markets, 1100, xonly);
  say("rendezvous @1100:", rz ? `solver=${rz.solverPubkey.slice(0, 12)} min=${rz.minSats} max=${rz.maxSats}` : "NONE");
}

// A live invoice from the deployed server, exactly what the send box receives.
const pr = await attempt("resolve payRequest", async () =>
  (await fetch(`https://${LNURL_DOMAIN}/.well-known/lnurlp/demomu7632zk`)).json());
const cb = await attempt("callback -> bolt11", async () =>
  (await fetch(`${(pr as { callback: string }).callback}?amount=1100000`)).json());
const bolt11 = (cb as { pr?: string } | undefined)?.pr;
say("bolt11:", bolt11 ? bolt11.slice(0, 32) + "…" : "NONE");

if (bolt11) {
  await attempt("decodeInvoice (injected)", () => invoiceFactsFromBolt11(bolt11));

  const ctx = { wallet: {}, prefs: {} } as never;
  const req = { raw: bolt11, amount: 1100 };

  // 1. A rail built right here, with no dependency on the app's own wiring.
  const local = solverLightningRail({
    arkServerUrl: "https://mutinynet.arkade.sh",
    emulatorPubkey: emuHex!,
    fallbackEmulatorPubkey: xonly!,
    decodeInvoice: invoiceFactsFromBolt11,
    discover: () => discoverMarkets({ network: NETWORK, registryUrl: defaultRegistryUrls(NETWORK)[0] }),
    connect: async (r, fn) => fn(relayTransport(r.transports.nostr.relays[0]!, { solverPubkey: r.solverPubkey, clientPubkey: "00".repeat(32) })),
    persist: async () => undefined,
  });
  say("local rail  match:", local.match(req, ctx));
  await attempt("local rail available", async () => say("local rail  available:", await local.available?.(req, ctx)));

  // 2. The app's own factory, which is what the send box actually registers.
  const app = createLightningRail();
  say("app rail    match:", app.match(req, ctx));
  await attempt("app rail available", async () => say("app rail    available:", await app.available?.(req, ctx)));
}

say("— done —");
