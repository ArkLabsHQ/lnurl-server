import { useId, useState } from "react";
import { api, errMsg, query, type AddressPage, type ApiKey, type BlacklistEntry, type Domain } from "../api.js";
import { ago, listText, when } from "../lib.js";
import { Alert, Badge, Dialog, Empty, Field, LoadError, Loading, Page, SecretDialog, useAction, useConfirm, useDebounced, useLoad, useToast } from "../ui.js";

const scopeName = (domains: Domain[], id: number | null, all: string) =>
  id == null ? all : domains.find((d) => d.id === id)?.domain ?? `domain #${id}`;

export function ApiKeys() {
  const list = useLoad(() => api.get<ApiKey[]>("/api-keys"), []);
  const domains = useLoad(() => api.get<Domain[]>("/domains"), []);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ key: string; label: string }>();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const allDomains = domains.data ?? [];
  const requiring = allDomains.filter((d) => d.requireApiKey).map((d) => d.domain);

  const revoke = async (k: ApiKey) => {
    const label = k.label ?? "this key";
    if (!await confirm({
      title: `Revoke ${label}?`,
      body: <p>Wallets sending it can no longer register addresses. Existing addresses keep receiving payments.</p>,
      confirmLabel: "Revoke key",
      danger: true,
    })) return;
    await run(async () => { await api.del(`/api-keys/${k.id}`); await list.reload(); }, `${label} revoked`);
  };

  return (
    <Page title="API keys" intro="Keys let wallets register addresses on domains that require one. Wallets send them in the X-API-Key header."
      actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New key</button>}>
      {domains.data && (
        requiring.length
          ? <Alert tone="info"><p>Required on {listText(requiring, 5)}.</p></Alert>
          : <Alert tone="off"><p>No domain requires a key yet. Turn on “Require API key” for a domain under <a href="#/domains">Domains</a>.</p></Alert>
      )}
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="keys" /> : !list.data ? null : !list.data.length ? (
        <Empty title="No keys yet" action={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New key</button>}>
          Create one for each wallet or partner that registers on a key-only domain.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Label</th><th>Works on</th><th>Status</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {list.data.map((k) => (
                <tr key={k.id}>
                  <td>{k.label ? <strong>{k.label}</strong> : <span className="muted">No label</span>}</td>
                  <td>{scopeName(allDomains, k.domainId, "All domains")}</td>
                  <td>{k.status === "active" ? <Badge tone="ok">Active</Badge> : <Badge tone="off">Revoked</Badge>}</td>
                  <td className="nowrap"><span title={when(k.createdAt)}>{ago(k.createdAt)}</span></td>
                  <td className="nowrap">{k.lastUsedAt ? <span title={when(k.lastUsedAt)}>{ago(k.lastUsedAt)}</span> : <span className="muted">Never</span>}</td>
                  <td className="actions">
                    {k.status === "active" && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void revoke(k)}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewKey domains={allDomains} onClose={() => setCreating(false)}
          onCreated={(key, label) => { setCreating(false); setCreated({ key, label }); void list.reload(); }} />
      )}
      {created && (
        <SecretDialog title="Key created" label="API key" secret={created.key} onClose={() => setCreated(undefined)}>
          <p>Give <strong>{created.label}</strong> to the wallet that registers with it. Only its hash is stored here.</p>
        </SecretDialog>
      )}
    </Page>
  );
}

function NewKey({ domains, onClose, onCreated }: { domains: Domain[]; onClose: () => void; onCreated: (key: string, label: string) => void }) {
  const [label, setLabel] = useState("");
  const [domainId, setDomainId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const scoped = domains.find((d) => String(d.id) === domainId);
  const blocker = !label.trim() ? "Give the key a label." : undefined;
  const create = async () => {
    if (blocker) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ key: string }>("/api-keys", { label: label.trim(), domainId: domainId ? Number(domainId) : null });
      onCreated(r.key, label.trim());
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title="New API key" onClose={onClose} onSubmit={() => void create()}
      footer={
        <>
          <span className="why" role="status">{blocker}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(blocker)}>{busy ? "Creating…" : "Create key"}</button>
        </>
      }>
      {error && <Alert tone="bad"><p>{error}</p></Alert>}
      <Field label="Label" hint="Who or what uses it, so you know which key to revoke later.">
        {(p) => <input {...p} data-autofocus maxLength={100} placeholder="Acme wallet" value={label} onChange={(e) => setLabel(e.target.value)} />}
      </Field>
      <Field label="Works on" hint={scoped
        ? scoped.requireApiKey ? `Only for ${scoped.domain}.` : `Only for ${scoped.domain}, which doesn't require a key yet.`
        : "Every domain, now and later."}>
        {(p) => (
          <select {...p} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
          </select>
        )}
      </Field>
    </Dialog>
  );
}

export function Blacklist() {
  const list = useLoad(() => api.get<BlacklistEntry[]>("/blacklist"), []);
  const domains = useLoad(() => api.get<Domain[]>("/domains"), []);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const { run, busy } = useAction();
  const allDomains = domains.data ?? [];
  const term = filter.trim().toLowerCase();
  const rows = (list.data ?? []).filter((b) => !term || b.username.includes(term) || (b.reason ?? "").toLowerCase().includes(term));
  const unblock = (b: BlacklistEntry) =>
    run(async () => { await api.del(`/blacklist/${b.id}`); await list.reload(); }, `${b.username} unblocked`);

  return (
    <Page title="Blacklist" intro="Usernames no wallet can register. Blocking a name doesn't touch an address that already uses it."
      actions={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Block a username</button>}>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="the blacklist" /> : !list.data ? null : !list.data.length ? (
        <Empty title="Nothing blocked" action={<button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>Block a username</button>}>
          Block names you don't want registered, such as your brand or abusive words.
        </Empty>
      ) : (
        <>
          <div className="toolbar">
            <Field label="Filter" className="grow">
              {(p) => <input {...p} type="search" placeholder="Username or reason" value={filter} onChange={(e) => setFilter(e.target.value)} />}
            </Field>
          </div>
          {rows.length === 0 ? <Empty title="Nothing matches that filter" /> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Username</th><th>Blocked on</th><th>Reason</th><th>Added</th><th /></tr></thead>
                <tbody>
                  {rows.map((b) => (
                    <tr key={b.id}>
                      <td><strong>{b.username}</strong></td>
                      <td>{scopeName(allDomains, b.domainId, "All domains")}</td>
                      <td>{b.reason ?? <span className="muted">—</span>}</td>
                      <td className="nowrap"><span title={when(b.createdAt)}>{ago(b.createdAt)}</span></td>
                      <td className="actions"><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void unblock(b)}>Unblock</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {adding && <BlockName domains={allDomains} entries={list.data ?? []} onClose={() => setAdding(false)} onBlocked={() => { setAdding(false); void list.reload(); }} />}
    </Page>
  );
}

function BlockName({ domains, entries, onClose, onBlocked }: { domains: Domain[]; entries: BlacklistEntry[]; onClose: () => void; onBlocked: () => void }) {
  const [username, setUsername] = useState("");
  const [domainId, setDomainId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const listId = useId();
  const name = username.trim().toLowerCase();
  const term = useDebounced(name, 200);
  const matches = useLoad(
    () => (term ? api.get<AddressPage>(`/addresses${query({ q: term, domainId, limit: 100 })}`).then((p) => p.addresses) : Promise.resolve([])),
    [term, domainId],
  );
  const inUse = (matches.data ?? []).filter((a) => a.username === name && a.status !== "revoked");
  // The server answers a duplicate with a bare 500, so catch it here.
  const already = entries.find((b) => b.username === name && (b.domainId === null || String(b.domainId) === domainId));
  const blocker = !name ? "Enter a username."
    : already ? `Already blocked on ${scopeName(domains, already.domainId, "all domains")}.`
    : undefined;
  const block = async () => {
    if (blocker) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/blacklist", { username: name, domainId: domainId ? Number(domainId) : null, reason: reason.trim() || undefined });
      toast(`${name} blocked`);
      onBlocked();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Block a username" onClose={onClose} onSubmit={() => void block()}
      footer={
        <>
          <span className="why" role="status">{blocker}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(blocker)}>{busy ? "Blocking…" : "Block"}</button>
        </>
      }>
      {error && <Alert tone="bad"><p>{error}</p></Alert>}
      <Field label="Username" hint="Matched without case. Suggestions are names already in use.">
        {(p) => (
          <>
            <input {...p} data-autofocus list={listId} autoComplete="off" spellCheck={false} placeholder="satoshi" value={username} onChange={(e) => setUsername(e.target.value)} />
            <datalist id={listId}>{[...new Set((matches.data ?? []).map((a) => a.username))].slice(0, 8).map((u) => <option key={u} value={u} />)}</datalist>
          </>
        )}
      </Field>
      {inUse.length > 0 && (
        <Alert tone="warn">
          <p>{listText(inUse.map((a) => `${a.username}@${a.domain}`))} already {inUse.length === 1 ? "uses" : "use"} this name and keep{inUse.length === 1 ? "s" : ""} working. Revoke {inUse.length === 1 ? "it" : "them"} under <a href="#/addresses">Addresses</a> to stop payments.</p>
        </Alert>
      )}
      <Field label="Blocked on" hint={domainId ? "Only this domain." : "Every domain, now and later."}>
        {(p) => (
          <select {...p} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
          </select>
        )}
      </Field>
      <Field label="Reason" hint="Optional. A note for whoever reads this list later.">
        {(p) => <input {...p} maxLength={200} placeholder="Reserved for the brand" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </Dialog>
  );
}
