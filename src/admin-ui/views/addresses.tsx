import { Fragment, useState, type ReactNode } from "react";
import { api, errMsg, notConfigured, query, type Address, type AddressPage, type BlacklistEntry, type ClaimCode, type Domain, type ReconcileRow, type SettlementRow } from "../api.js";
import { ago, plural, sentence, usernameProblem, when } from "../lib.js";
import {
  Alert, Badge, Check, Checks, Empty, Field, LoadError, Loading, Page, SecretDialog, Wizard, href, navigate,
  useAction, useConfirm, useDebounced, useLoad, type CheckState, type Tone,
} from "../ui.js";
import { NameRulesText } from "./domains.js";
import { Arrivals } from "./payments.js";

const STATUS: Record<Address["status"], { tone: Tone; label: string; title: string }> = {
  active: { tone: "ok", label: "Active", title: "Receiving payments" },
  reserved: { tone: "info", label: "Reserved", title: "Waiting for its owner to claim it with the code" },
  revoked: { tone: "off", label: "Revoked", title: "Payers get an error; the name stays taken" },
};

const isNameless = (a: Address) => a.sessionId !== null && a.username === a.sessionId;
const nameOf = (a: Address) => (isNameless(a) ? "Nameless receiver" : `${a.username}@${a.domain ?? "?"}`);
const PAGE_SIZE = 50;

interface Issued { title: string; label: string; secret: string; lead: ReactNode }

export function Addresses({ query: q }: { query: URLSearchParams }) {
  const [show, setShow] = useState<"addresses" | "codes">(q.get("show") === "codes" ? "codes" : "addresses");
  const [creating, setCreating] = useState(q.has("new"));
  const [issued, setIssued] = useState<Issued>();
  const [version, setVersion] = useState(0);
  const domains = useLoad(() => api.get<Domain[]>("/domains"), []);
  const closeNew = () => {
    setCreating(false);
    if (q.has("new")) navigate("/addresses");
  };
  return (
    <Page title="Addresses" intro="Lightning addresses on your domains, and the claim codes people use to get one."
      actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New address</button>}>
      <div className="segmented" role="group" aria-label="Show">
        <button type="button" aria-pressed={show === "addresses"} onClick={() => setShow("addresses")}>Addresses</button>
        <button type="button" aria-pressed={show === "codes"} onClick={() => setShow("codes")}>Claim codes</button>
      </div>
      {show === "addresses"
        ? <AddressList domains={domains.data ?? []} version={version} />
        : <ClaimCodes domains={domains.data ?? []} version={version} />}
      {creating && (
        <NewAddress domains={domains.data} onClose={closeNew}
          onIssued={(next, kind) => {
            closeNew();
            setIssued(next);
            setVersion((v) => v + 1);
            setShow(kind === "code" ? "codes" : "addresses");
          }} />
      )}
      {issued && (
        <SecretDialog title={issued.title} label={issued.label} secret={issued.secret} onClose={() => setIssued(undefined)}>
          {issued.lead}
        </SecretDialog>
      )}
    </Page>
  );
}

function AddressList({ domains, version }: { domains: Domain[]; version: number }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [domainId, setDomainId] = useState("");
  // One cursor per page above this one, so Newer is a pop and a reload stays on this page.
  const [cursors, setCursors] = useState<string[]>([]);
  const [open, setOpen] = useState<number>();
  const q = useDebounced(search.trim().toLowerCase(), 250);
  const cursor = cursors.at(-1) ?? "";
  const page = useLoad(
    () => api.get<AddressPage>(`/addresses${query({ q, status, domainId, cursor, limit: PAGE_SIZE })}`),
    [q, status, domainId, cursor, version],
  );
  const rows = page.data?.addresses ?? [];
  const filtered = Boolean(q || status || domainId);

  return (
    <>
      <div className="toolbar">
        <Field label="Search" className="grow">
          {(p) => <input {...p} type="search" placeholder="Part of a username" value={search} onChange={(e) => { setSearch(e.target.value); setCursors([]); }} />}
        </Field>
        <Field label="Status">
          {(p) => (
            <select {...p} value={status} onChange={(e) => { setStatus(e.target.value); setCursors([]); }}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="reserved">Reserved</option>
              <option value="revoked">Revoked</option>
            </select>
          )}
        </Field>
        <Field label="Domain">
          {(p) => (
            <select {...p} value={domainId} onChange={(e) => { setDomainId(e.target.value); setCursors([]); }}>
              <option value="">All</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </select>
          )}
        </Field>
      </div>
      {page.error && <LoadError error={page.error} retry={page.reload} />}
      {page.loading ? <Loading what="addresses" /> : !page.data ? null : rows.length === 0 ? (
        filtered
          ? <Empty title="No address matches" action={<button type="button" className="btn" onClick={() => { setSearch(""); setStatus(""); setDomainId(""); setCursors([]); }}>Clear filters</button>} />
          : <Empty title="No addresses yet">Wallets register their own, or create one with New address.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Address</th><th>Status</th><th>Wallet</th><th>Rails</th><th>Created</th><th /></tr></thead>
            <tbody>
              {rows.map((a) => {
                const serving = a.rails.filter((r) => r.enabled && r.available).map((r) => r.label);
                return (
                  <Fragment key={a.id}>
                    <tr className={open === a.id ? "open" : undefined}>
                      <td>
                        <strong>{nameOf(a)}</strong>
                        {isNameless(a) && <span className="sub mono" title={a.username}>{a.username.slice(0, 12)}… on {a.domain}</span>}
                      </td>
                      <td><Badge tone={STATUS[a.status].tone} title={STATUS[a.status].title}>{STATUS[a.status].label}</Badge></td>
                      <td>
                        {a.status === "reserved" ? <span className="muted">—</span>
                          : a.online ? <Badge tone="ok" title="Its wallet is connected">Online</Badge>
                          : <Badge tone="off" title="Its wallet isn't connected">Offline</Badge>}
                      </td>
                      <td className="small">{serving.length ? serving.join(", ") : <span className="muted">None serving</span>}</td>
                      <td className="nowrap"><span title={when(a.createdAt)}>{ago(a.createdAt)}</span></td>
                      <td className="actions">
                        <button type="button" className="btn btn-sm" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? undefined : a.id)}>
                          {open === a.id ? "Close" : "Manage"}
                        </button>
                        <a className="btn btn-sm" href={href("/settlements", { address: a.id, name: `${a.username}@${a.domain}` })}>Payments</a>
                      </td>
                    </tr>
                    {open === a.id && <AddressDetail address={a} onChanged={page.reload} />}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 0 || page.data?.nextCursor) && (
        <div className="pager">
          <button type="button" className="btn btn-sm" disabled={cursors.length === 0} onClick={() => setCursors(cursors.slice(0, -1))}>Newer</button>
          <span className="muted small">Page {cursors.length + 1}</span>
          {/* Until the next page lands, data is still this one's, whose nextCursor is already pushed. */}
          <button type="button" className="btn btn-sm" disabled={!page.data?.nextCursor || page.data.nextCursor === cursor}
            onClick={() => page.data?.nextCursor && setCursors([...cursors, page.data.nextCursor])}>Older</button>
        </div>
      )}
    </>
  );
}

function AddressDetail({ address, onChanged }: { address: Address; onChanged: () => Promise<void> }) {
  const { run, busy } = useAction();
  const confirm = useConfirm();
  const [arrivals, setArrivals] = useState<ReconcileRow | Error | "checking">();
  const name = nameOf(address);

  const setRail = (railId: string, label: string, on: boolean) => run(async () => {
    const disabledRails = on ? address.disabledRails.filter((r) => r !== railId) : [...address.disabledRails, railId];
    await api.patch(`/addresses/${address.id}/rails`, { disabledRails });
    await onChanged();
  }, `${label} ${on ? "on" : "off"} for ${name}`);

  const checkArrivals = async () => {
    setArrivals("checking");
    try {
      setArrivals(await api.get<ReconcileRow>(`/addresses/${address.id}/reconcile`));
    } catch (e) {
      setArrivals(e instanceof Error ? e : new Error(errMsg(e)));
    }
  };

  const setStatus = async (next: "active" | "revoked") => {
    if (next === "revoked" && !await confirm({
      title: `Revoke ${name}?`,
      body: <p>Payers get an error instead of an invoice. The name stays taken, and you can reactivate it later.</p>,
      confirmLabel: "Revoke address",
      danger: true,
    })) return;
    await run(async () => { await api.patch(`/addresses/${address.id}`, { status: next }); await onChanged(); },
      next === "revoked" ? `${name} revoked` : `${name} reactivated`);
  };

  const remove = async () => {
    // The server keeps payment records pointing at their address, so it refuses to delete one that has any.
    const paid = await api.get<SettlementRow[]>(`/settlements${query({ addressId: address.id, limit: 1 })}`).then((r) => r.length > 0, () => false);
    if (paid && address.status === "revoked") {
      await confirm({
        title: `${name} can't be deleted`,
        body: <p>Its payment records still point at it, so the server keeps it. It is already revoked, so payers get an error.</p>,
        confirmLabel: "OK",
      });
      return;
    }
    if (paid) {
      if (await confirm({
        title: `${name} can't be deleted`,
        body: <p>Its payment records still point at it, so the server keeps it. Revoke it instead: payers get an error and the name stays taken.</p>,
        confirmLabel: "Revoke instead",
      })) await run(async () => { await api.patch(`/addresses/${address.id}`, { status: "revoked" }); await onChanged(); }, `${name} revoked`);
      return;
    }
    if (!await confirm({
      title: `Delete ${name}?`,
      body: <p>The address stops working and its name becomes free for anyone to register.</p>,
      confirmLabel: "Delete address",
      danger: true,
    })) return;
    await run(async () => { await api.del(`/addresses/${address.id}`); await onChanged(); }, `${name} deleted`);
  };

  return (
    <tr className="detail">
      <td colSpan={6}>
        <div className="detail-grid">
          <section aria-label="Rails">
            <h3>Rails</h3>
            <p>Switch one off to drop it from this address's payRequest. Server-wide state is under Rails.</p>
            {address.rails.map((rail) => (
              <Check key={rail.id} toggle plain title={rail.label} checked={rail.enabled} disabled={busy}
                description={rail.available ? "Serving" : rail.enabled ? sentence(rail.reason ?? "unavailable") : "Off for this address"}
                onChange={(on) => void setRail(rail.id, rail.label, on)} />
            ))}
          </section>
          <section aria-label="Unrecorded payments">
            <h3>Unrecorded payments</h3>
            <p>Asks the indexer what reached this address and compares it with the records here.</p>
            <button type="button" className="btn btn-sm" disabled={arrivals === "checking"} onClick={() => void checkArrivals()}>
              {arrivals === "checking" ? "Checking…" : "Check arrivals"}
            </button>
            {arrivals instanceof Error && (
              <Alert tone={notConfigured(arrivals) ? "off" : "bad"}><p>{sentence(arrivals.message)}</p></Alert>
            )}
            {arrivals && typeof arrivals === "object" && !(arrivals instanceof Error) && (
              <div className="stack mt">
                {Boolean(arrivals.unattributed) && (
                  <Alert tone="warn" title={`${plural(arrivals.unattributed ?? 0, "arrival")} without a settlement record`}>
                    <p>The money reached the user's own address; only the bookkeeping is missing. Usually it was paid after this server stopped watching the destination.</p>
                  </Alert>
                )}
                <Arrivals row={arrivals} />
              </div>
            )}
          </section>
          <section aria-label="Status">
            <h3>Status</h3>
            {/* Not for a reservation: the server would happily mark it active, with no wallet and a dead code. */}
            {address.status === "reserved" ? (
              <p>Reserved until its owner claims it with the code. Delete it to release the name; the code then stops working.</p>
            ) : address.status === "revoked" ? (
              <>
                <p>Revoked: payers get an error. Reactivate it to accept payments again.</p>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void setStatus("active")}>Reactivate</button>
              </>
            ) : (
              <>
                <p>Revoke to refuse payments while keeping the name taken.</p>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void setStatus("revoked")}>Revoke</button>
              </>
            )}
            {address.status !== "reserved" && <p className="mt">Delete to remove it and free the name.</p>}
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove()}>Delete</button>
          </section>
        </div>
      </td>
    </tr>
  );
}

type Method = "mint" | "reserve" | "code";
const METHODS: Array<{ id: Method; title: string; description: string; finish: string }> = [
  { id: "mint", title: "Mint an active address", description: "You pick the name. You get a secret a wallet uses to receive on it straight away.", finish: "Mint address" },
  { id: "reserve", title: "Reserve a name", description: "You pick the name. Its owner claims it with a one-time code.", finish: "Reserve name" },
  { id: "code", title: "Issue a claim code", description: "No name yet. Whoever holds the code picks any free name, even where wallets can't choose one.", finish: "Issue code" },
];

/** What the server would say about a name, asked ahead of time. Advisory: the server checks again on create. */
function useNameCheck(domain: Domain | undefined, name: string): Array<{ state: CheckState; text: string }> {
  const settled = useDebounced(name, 300);
  const format = domain && name ? usernameProblem(name, domain) : undefined;
  const lookup = !domain || !settled || usernameProblem(settled, domain) ? "" : settled;
  const taken = useLoad(
    () => (lookup && domain
      ? api.get<AddressPage>(`/addresses${query({ q: lookup, domainId: domain.id, limit: 1000 })}`)
        .then((p) => ({ name: lookup, domainId: domain.id, hit: p.addresses.find((a) => a.username === lookup), more: Boolean(p.nextCursor) }))
      : Promise.resolve(undefined)),
    [domain?.id, lookup],
  );
  const blacklist = useLoad(() => api.get<BlacklistEntry[]>("/blacklist"), []);
  if (!domain || !name) return [];
  if (format) return [{ state: "fail", text: format }];
  const items: Array<{ state: CheckState; text: string }> = [{ state: "pass", text: `Fits ${domain.domain}'s name rules` }];
  if (taken.error) return items;
  if (settled !== name || taken.data?.name !== name || taken.data.domainId !== domain.id) {
    return [...items, { state: "wait", text: "Checking it's free…" }];
  }
  // The search matches substrings newest first, so past one page of look-alikes a miss proves nothing.
  items.push(taken.data.hit ? { state: "fail", text: `Taken: already ${taken.data.hit.status}` }
    : taken.data.more ? { state: "note", text: "Too many similar names to confirm it's free; the server checks on create" }
    : { state: "pass", text: "Free" });
  const blocked = blacklist.data?.find((b) => b.username === name && (b.domainId === null || b.domainId === domain.id));
  if (blacklist.data) items.push(blocked ? { state: "fail", text: `Blacklisted${blocked.reason ? `: ${blocked.reason}` : ""}` } : { state: "pass", text: "Not blacklisted" });
  return items;
}

function NewAddress({ domains, onClose, onIssued }: {
  domains?: Domain[];
  onClose: () => void;
  onIssued: (issued: Issued, kind: Method) => void;
}) {
  const [method, setMethod] = useState<Method>("mint");
  const [picked, setPicked] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fallback = domains?.find((d) => d.enabled) ?? domains?.[0];
  const domain = domains?.find((d) => d.domain === picked) ?? fallback;
  const needsName = method !== "code";
  const name = username.trim().toLowerCase();
  const checks = useNameCheck(domain, needsName ? name : "");
  const meta = METHODS.find((m) => m.id === method)!;

  const blocker = !domains ? "Loading domains…"
    : !domain ? "Add a domain first."
    : !needsName ? undefined
    : !name ? "Enter a username to continue."
    : checks.some((c) => c.state === "fail") ? "Pick a name that passes every check."
    : checks.some((c) => c.state === "wait") ? "Checking the name…"
    : undefined;

  const finish = async () => {
    if (!domain) return;
    setBusy(true);
    setError(undefined);
    try {
      if (method === "code") {
        const r = await api.post<{ claimCode: string }>("/claim-codes", { domain: domain.domain });
        onIssued({
          title: "Claim code issued",
          label: "Claim code",
          secret: r.claimCode,
          lead: <p>Give this code to the person who should get an address on <strong>{domain.domain}</strong>. Their wallet registers any free name with it, once.</p>,
        }, method);
      } else {
        const r = await api.post<{ username: string; domain: string; claimCode?: string; secret?: string }>("/addresses", { domain: domain.domain, username: name, mode: method });
        const address = `${r.username}@${r.domain}`;
        onIssued(method === "mint"
          ? { title: "Address minted", label: "Wallet secret", secret: r.secret ?? "", lead: <p><strong>{address}</strong> is active. Give this secret to the wallet that will receive on it: it is that wallet's token.</p> }
          : { title: "Name reserved", label: "Claim code", secret: r.claimCode ?? "", lead: <p><strong>{address}</strong> is reserved. Share this code with its owner; their wallet sends it to claim the address.</p> },
        method);
      }
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Wizard title="New address" finishLabel={meta.finish} onFinish={() => void finish()} onClose={onClose} busy={busy} error={error}
      steps={[
        {
          title: "Method",
          body: (
            <fieldset>
              <legend>How should it be created?</legend>
              <div className="choices">
                {METHODS.map((m) => (
                  <Check key={m.id} type="radio" name="method" title={m.title} description={m.description} checked={method === m.id}
                    autoFocus={method === m.id} onChange={() => setMethod(m.id)} />
                ))}
              </div>
            </fieldset>
          ),
        },
        {
          title: "Details",
          blocker,
          body: !domains?.length ? (
            <Empty title={domains ? "No domains yet" : "Loading domains…"} action={domains && <a className="btn" href="#/domains?new=1">New domain</a>}>
              {domains && "An address lives on a domain. Add one first."}
            </Empty>
          ) : (
            <>
              <Field label="Domain" hint={domain && <>{needsName ? "Names here: " : "The holder picks a name of "}<NameRulesText rules={domain} /></>}>
                {(p) => (
                  <select {...p} data-autofocus={needsName ? undefined : true} value={domain?.domain ?? ""} onChange={(e) => setPicked(e.target.value)}>
                    {domains.map((d) => <option key={d.id} value={d.domain}>{d.domain}{d.enabled ? "" : " (disabled)"}</option>)}
                  </select>
                )}
              </Field>
              {domain && !domain.enabled && <Alert tone="warn"><p>{domain.domain} is disabled. Its addresses can't receive until you enable it in Domains.</p></Alert>}
              {needsName && domain && (
                <div className="field">
                  <Field label="Username" hint={name ? <>The address will be <strong>{name}@{domain.domain}</strong></> : "Lowercase; uppercase letters are folded."}>
                    {(p) => <input {...p} data-autofocus placeholder="alice" autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />}
                  </Field>
                  <Checks items={checks} />
                </div>
              )}
            </>
          ),
        },
      ]} />
  );
}

function ClaimCodes({ domains, version }: { domains: Domain[]; version: number }) {
  const [domainId, setDomainId] = useState("");
  const list = useLoad(() => api.get<{ claimCodes: ClaimCode[] }>(`/claim-codes${query({ domainId })}`).then((r) => r.claimCodes), [domainId, version]);
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const revoke = async (c: ClaimCode) => {
    if (!await confirm({
      title: "Revoke this claim code?",
      body: <p>Whoever holds it can no longer register with it. Codes can't be shown again, so issue a new one if they still need an address.</p>,
      confirmLabel: "Revoke code",
      danger: true,
    })) return;
    await run(async () => { await api.del(`/claim-codes/${c.id}`); await list.reload(); }, "Claim code revoked");
  };
  const rows = list.data ?? [];
  return (
    <>
      <div className="toolbar">
        <Field label="Domain">
          {(p) => (
            <select {...p} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              <option value="">All</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </select>
          )}
        </Field>
        <span className="toolbar-note">Codes for any free name. A reserved name's code belongs to its address instead.</span>
      </div>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="claim codes" /> : !list.data ? null : rows.length === 0 ? (
        <Empty title="No claim codes yet">Issue one from New address when someone should pick their own name.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Domain</th><th>Issued</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.domain ?? <span className="muted">—</span>}</td>
                  <td className="nowrap"><span title={when(c.createdAt)}>{ago(c.createdAt)}</span></td>
                  <td>
                    {c.redeemedAt ? (
                      <>
                        <Badge tone="ok">Used</Badge>
                        <span className="sub">{c.username ? `by ${c.username}@${c.domain}` : "by an address deleted since"}, {ago(c.redeemedAt)}</span>
                      </>
                    ) : <Badge tone="info" title="Nobody has registered with it yet">Unused</Badge>}
                  </td>
                  <td className="actions">
                    {!c.redeemedAt && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revoke(c)}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
