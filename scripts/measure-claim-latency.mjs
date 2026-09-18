/**
 * Measures how long an offline receive takes to settle, end to end.
 *
 * Asks the deployed server for a real hold invoice, then polls its LUD-21
 * verify URL until `settled` flips, printing the elapsed time. The invoice is
 * only settled once something claims the solver's lockup, so this number IS the
 * claim latency plus the observation delay -- the thing a 15s poller dominates.
 *
 *   node scripts/measure-claim-latency.mjs <lightning-address> [sats]
 *
 * Nothing is paid here: pay the printed invoice from any wallet and the timer
 * measures from the moment it is paid. Prints one line per poll so a slow claim
 * is visible as it happens rather than only in the total.
 */
const address = process.argv[2] ?? "demomu7632zk@lnurl.mutinynet.arkade.sh";
const sats = Number(process.argv[3] ?? 1100);
const [user, domain] = address.split("@");

const pr = await (await fetch(`https://${domain}/.well-known/lnurlp/${user}`)).json();
if (pr.status === "ERROR") throw new Error(`payRequest: ${pr.reason}`);

const cb = await (await fetch(`${pr.callback}?amount=${sats * 1000}`)).json();
if (cb.status === "ERROR") throw new Error(`callback: ${cb.reason}`);
if (!cb.verify) throw new Error("no verify URL; cannot measure settlement");

console.log(`invoice (${sats} sats):\n${cb.pr}\n`);
console.log(`verify: ${cb.verify}\n`);
console.log("waiting for settlement — pay the invoice above…");

const started = Date.now();
let paidAt;
for (;;) {
  const v = await (await fetch(cb.verify)).json();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (v.settled) {
    console.log(`\nSETTLED after ${elapsed}s${paidAt ? ` (${((Date.now() - paidAt) / 1000).toFixed(1)}s since first observed as paid)` : ""}`);
    console.log(`preimage: ${v.preimage}`);
    break;
  }
  process.stdout.write(`\r  ${elapsed}s — settled=${v.settled}`);
  await new Promise((r) => setTimeout(r, 1000));
}
