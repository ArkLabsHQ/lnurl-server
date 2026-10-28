import { api, notConfigured, type DiscoveryView, type Domain, type QuoteUnitRow, type ServerRail, type SessionRow, type SettlementRow } from "../api.js";
import { ago, listText, num, plural } from "../lib.js";
import { Badge, Page, useLoad, type Tone } from "../ui.js";

interface Row { title: string; href: string; tone: Tone; state: string; detail: string }

const PENDING_CAP = 1000; // the settlements route's maximum page

type Loaded<T> = { data?: T; error?: Error };

/** One row per load: still checking, failed, switched off, or whatever `ready` makes of the data. */
function row<T>(title: string, href: string, load: Loaded<T>, ready: (data: T) => Omit<Row, "title" | "href">, off?: string): Row {
  if (load.error && off && notConfigured(load.error)) return { title, href, tone: "off", state: "Off", detail: off };
  if (load.error) return { title, href, tone: "bad", state: "Error", detail: load.error.message };
  if (load.data === undefined) return { title, href, tone: "off", state: "Checking…", detail: "" };
  return { title, href, ...ready(load.data) };
}

export function Dashboard() {
  const domains = useLoad(() => api.get<Domain[]>("/domains"), []);
  const count = useLoad(() => api.get<{ count: number }>("/addresses/count"), []);
  const sessions = useLoad(() => api.get<SessionRow[]>("/sessions"), [], 10_000);
  const rails = useLoad(() => api.get<{ rails: ServerRail[] }>("/rails").then((r) => r.rails), []);
  const discovery = useLoad(() => api.get<DiscoveryView>("/discovery"), []);
  const quotes = useLoad(() => api.get<QuoteUnitRow[]>("/quote-units"), []);
  const pending = useLoad(() => api.get<SettlementRow[]>(`/settlements?settled=false&limit=${PENDING_CAP}`), [], 10_000);

  const rows: Row[] = [
    row("Domains", domains.data?.length === 0 ? "#/domains?new=1" : "#/domains", domains, (list) => {
      if (!list.length) return { tone: "warn", state: "None yet", detail: "Add a domain to start handing out Lightning addresses." };
      const off = list.filter((d) => !d.enabled).length;
      const addresses = count.data ? `, ${plural(count.data.count, "address", "addresses")} in total` : "";
      return {
        tone: off === list.length ? "bad" : off ? "warn" : "ok",
        state: off ? `${off} disabled` : "Serving",
        detail: `${listText(list.map((d) => d.domain))}${addresses}`,
      };
    }),
    row("Wallet sessions", "#/sessions", sessions, (list) => {
      const online = list.reduce((n, s) => n + s.addresses.filter((a) => a.status === "active").length, 0);
      return list.length
        ? { tone: "ok", state: `${num(list.length)} connected`, detail: `${plural(online, "address", "addresses")} can receive through a connected wallet.` }
        : { tone: "off", state: "None", detail: "No wallet is connected right now." };
    }),
    row("Offline receive", "#/solvers", discovery, (d) => d.ready
      ? { tone: "ok", state: "Ready", detail: `${plural(d.candidateCount, "routing candidate")} on ${d.network}${d.refreshedAt ? `, checked ${ago(d.refreshedAt)}` : ""}.` }
      : { tone: "bad", state: "Unavailable", detail: d.reason ?? "No solver card offers a usable Lightning market." },
    "Not configured. Addresses receive only while their wallet is connected."),
    row("Receive rails", "#/rails", rails, (list) => {
      const configured = list.filter((r) => r.configured);
      const down = configured.filter((r) => !r.ready);
      const unset = list.length - configured.length;
      return down.length
        ? { tone: "warn", state: "Degraded", detail: `${listText(down.map((r) => r.label))} ${down.length === 1 ? "is" : "are"} unavailable.` }
        : { tone: "ok", state: "Ready", detail: `${plural(configured.length, "rail")} ready${unset ? `, ${unset} not configured` : ""}.` };
    }),
    row("Price feeds", "#/quotes", quotes, (units) => {
      if (!units.length) return { tone: "off", state: "None", detail: "No quote units. Payers can only pay in sats." };
      const stale = units.filter((u) => !u.fresh).map((u) => u.code);
      return stale.length
        ? { tone: "warn", state: "Stale", detail: `${listText(stale)} ${stale.length === 1 ? "has" : "have"} no fresh price, so payers can't use ${stale.length === 1 ? "it" : "them"}.` }
        : { tone: "ok", state: "Live", detail: `${listText(units.map((u) => u.code))} priced live.` };
    }, "Payment quotes are not configured."),
    row("Pending payments", "#/settlements?settled=false", pending, (list) => {
      if (!list.length) return { tone: "ok", state: "None", detail: "Every payment request has settled." };
      // At the cap the list is only the newest pending ones, so its oldest would be a lie.
      if (list.length >= PENDING_CAP) return { tone: "info", state: `${num(PENDING_CAP)}+ pending`, detail: "A request stays pending until it is paid." };
      const oldest = Math.min(...list.map((s) => s.createdAt));
      return { tone: "info", state: `${num(list.length)} pending`, detail: `Oldest started ${ago(oldest)}. A request stays pending until it is paid.` };
    }, "No settlement store is configured."),
  ];

  const attention = rows.filter((r) => r.tone === "warn" || r.tone === "bad").length;
  const checking = rows.some((r) => r.state === "Checking…");
  const summary = checking ? "Checking…" : attention ? `${plural(attention, "item needs", "items need")} attention` : "Everything is serving";
  const tone = checking ? "off" : rows.some((r) => r.tone === "bad") ? "bad" : attention ? "warn" : "ok";

  return (
    <Page title="Dashboard" intro="The state of this server at a glance. Each row opens the page where you act on it.">
      <p className={`summary ${tone}`}>{summary}</p>
      <ul className="health">
        {rows.map((r) => (
          <li key={r.title}>
            <span><Badge tone={r.tone}>{r.state}</Badge></span>
            <div>
              <a className="health-title" href={r.href}>{r.title}</a>
              {r.detail && <p className="health-detail">{r.detail}</p>}
            </div>
          </li>
        ))}
      </ul>
    </Page>
  );
}
