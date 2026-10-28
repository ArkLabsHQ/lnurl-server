import { useId, useState } from "react";
import { ApiError, api, errMsg, query, type AddressPage, type AllocationMode, type Domain, type SettingsResponse } from "../api.js";
import { charsetProblem, domainProblem, intOrNull, intProblem, normalizeDomain, num, plural, sats, usernameProblem, type NameRules } from "../lib.js";
import { Alert, Badge, Check, Checks, Dialog, Empty, Field, LoadError, Loading, Page, Wizard, navigate, useAction, useConfirm, useLoad, useToast } from "../ui.js";

export const MODES: Array<{ id: AllocationMode; title: string; short: string; description: string }> = [
  { id: "self", title: "Wallets choose their name", short: "Wallet picks", description: "A wallet registers the username it asks for, when it's free." },
  { id: "random", title: "Random names", short: "Random", description: "A wallet that asks for no name gets one like swift-otter." },
  { id: "admin", title: "Names you assign", short: "Admin-assigned", description: "Tells wallets names come from you: mint or reserve them under Addresses." },
  { id: "session", title: "Nameless receivers", short: "Nameless", description: "A wallet can receive at an LNURL that has no lightning address." },
];

interface Draft {
  domain: string;
  modes: AllocationMode[];
  requireApiKey: boolean;
  enabled: boolean;
  maxPerSession: string;
  minLen: string;
  maxLen: string;
  charset: string;
  minSendable: string;
  maxSendable: string;
}

// Blank-domain defaults are the server's own (DomainsRepo.create) plus the two modes most domains want.
const draftOf = (d?: Domain): Draft => ({
  domain: d?.domain ?? "",
  modes: d?.allocationModes ?? ["self", "random"],
  requireApiKey: d?.requireApiKey ?? false,
  enabled: d?.enabled ?? true,
  maxPerSession: d?.maxPerSession?.toString() ?? "",
  minLen: String(d?.usernameMinLen ?? 1),
  maxLen: String(d?.usernameMaxLen ?? 32),
  charset: d?.usernamePattern ?? "a-z0-9._-",
  minSendable: d?.minSendable?.toString() ?? "",
  maxSendable: d?.maxSendable?.toString() ?? "",
});

const bodyOf = (d: Draft) => ({
  allocationModes: MODES.map((m) => m.id).filter((id) => d.modes.includes(id)),
  requireApiKey: d.requireApiKey,
  enabled: d.enabled,
  maxPerSession: intOrNull(d.maxPerSession),
  usernameMinLen: Number(d.minLen),
  usernameMaxLen: Number(d.maxLen),
  usernamePattern: d.charset.trim(),
  minSendable: intOrNull(d.minSendable),
  maxSendable: intOrNull(d.maxSendable),
});

function problemsOf(d: Draft) {
  const minLen = intProblem(d.minLen);
  const maxLen = intProblem(d.maxLen) ?? (!minLen && Number(d.maxLen) < Number(d.minLen) ? "Can't be shorter than the shortest name." : undefined);
  const minSendable = intProblem(d.minSendable, { optional: true });
  const maxSendable = intProblem(d.maxSendable, { optional: true })
    ?? (!minSendable && d.minSendable.trim() && d.maxSendable.trim() && Number(d.maxSendable) < Number(d.minSendable) ? "Can't be below the minimum." : undefined);
  return { maxPerSession: intProblem(d.maxPerSession, { optional: true }), minLen, maxLen, charset: charsetProblem(d.charset.trim()), minSendable, maxSendable };
}
type Problems = ReturnType<typeof problemsOf>;
const anyProblem = (p: Partial<Problems>) => Object.values(p).some(Boolean);

type ServerLimits = { min: number; max: number } | undefined;

const modeShort = (id: AllocationMode) => MODES.find((m) => m.id === id)?.short ?? id;

export const NameRulesText = ({ rules }: { rules: NameRules }) => (
  <>{rules.usernameMinLen}–{rules.usernameMaxLen} characters from <code>{rules.usernamePattern}</code></>
);
const amountText = (min: number | null, max: number | null): string =>
  min == null && max == null ? "Server limits" : `${min != null ? sats(min) : "server min"} to ${max != null ? sats(max) : "server max"}`;

export function Domains({ query: q }: { query: URLSearchParams }) {
  const list = useLoad(() => api.get<Domain[]>("/domains"), []);
  const settings = useLoad(() => api.get<SettingsResponse>("/settings"), []);
  const [creating, setCreating] = useState(q.has("new"));
  const [editing, setEditing] = useState<Domain>();
  const confirm = useConfirm();
  const { run, busy } = useAction();
  const editable = settings.data?.editable;
  const server: ServerLimits = editable?.minSendable && editable.maxSendable
    ? { min: Number(editable.minSendable.value), max: Number(editable.maxSendable.value) }
    : undefined;

  const closeNew = () => {
    setCreating(false);
    if (q.has("new")) navigate("/domains");
  };
  const remove = async (d: Domain) => {
    const count = await api.get<AddressPage>(`/addresses${query({ domainId: d.id, limit: 1000 })}`).then((p) => p.addresses.length, () => undefined);
    const addresses = count === undefined ? "Every address on it is deleted with it."
      : count >= 1000 ? "Its 1,000+ addresses are deleted with it."
      : count ? `Its ${plural(count, "address", "addresses")} ${count === 1 ? "is" : "are"} deleted with it.`
      : "It has no addresses.";
    const ok = await confirm({
      title: `Delete ${d.domain}?`,
      body: (
        <>
          <p>{addresses} Claim codes, API keys and blacklist entries scoped to it go too. This can't be undone.</p>
          {count !== 0 && <p className="muted">If any of its addresses has payment records, the server keeps them and refuses. Disable the domain instead.</p>}
        </>
      ),
      confirmLabel: "Delete domain",
      danger: true,
      typeToConfirm: d.domain,
    });
    if (ok) await run(async () => {
      await api.del(`/domains/${d.id}`).catch((e: unknown) => {
        throw e instanceof ApiError && e.status === 500
          ? new Error(`${d.domain} wasn't deleted. The server refuses while any of its addresses has payment records; disable it instead.`)
          : e;
      });
      await list.reload();
    }, `${d.domain} deleted`);
  };

  return (
    <Page title="Domains" intro="Each domain serves its own Lightning addresses (name@domain), with its own rules for who gets one."
      actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New domain</button>}>
      {list.error && <LoadError error={list.error} retry={list.reload} />}
      {list.loading ? <Loading what="domains" /> : !list.data ? null : !list.data.length ? (
        <Empty title="No domains yet" action={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New domain</button>}>
          Add the domain people will put after the @ in their Lightning address.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Domain</th><th>Who can get an address</th><th>Names</th><th>Amounts</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.domain}</strong></td>
                  <td>
                    {d.allocationModes.length
                      ? d.allocationModes.map((m) => <span key={m} className="chip" title={MODES.find((x) => x.id === m)?.description}>{modeShort(m)}</span>)
                      : <span className="muted">Only names you assign</span>}
                    {d.requireApiKey && <span className="chip" title="Wallets must send an API key to register">Key required</span>}
                    {d.maxPerSession != null && <span className="chip">{num(d.maxPerSession)} per wallet</span>}
                  </td>
                  <td className="small"><NameRulesText rules={d} /></td>
                  <td className="small nowrap">{amountText(d.minSendable, d.maxSendable)}</td>
                  <td>{d.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge tone="off" title="Its addresses are offline">Disabled</Badge>}</td>
                  <td className="actions">
                    <button type="button" className="btn btn-sm" onClick={() => setEditing(d)}>Edit</button>
                    <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void remove(d)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewDomain existing={list.data?.map((d) => d.domain) ?? []} server={server} onClose={closeNew}
          onCreated={() => { closeNew(); void list.reload(); }} />
      )}
      {editing && (
        <EditDomain domain={editing} server={server} onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); void list.reload(); }} />
      )}
    </Page>
  );
}

function NewDomain({ existing, server, onClose, onCreated }: { existing: string[]; server: ServerLimits; onClose: () => void; onCreated: () => void }) {
  const [draft, setDraft] = useState(draftOf);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const name = normalizeDomain(draft.domain);
  const nameProblem = domainProblem(name) ?? (existing.includes(name) ? `${name} is already added.` : undefined);
  const problems = problemsOf(draft);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.post("/domains", { domain: name, ...bodyOf(draft) });
      toast(`${name} added`);
      onCreated();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  const nameHint = name && name !== draft.domain.trim()
    ? `Saved as ${name}: no scheme, path or port.`
    : "The part after the @ in name@domain, without a port. Its /.well-known/lnurlp requests must reach this server.";
  return (
    <Wizard title="New domain" finishLabel="Create domain" onFinish={() => void create()} onClose={onClose} busy={busy} error={error}
      steps={[
        {
          title: "Domain",
          blocker: !draft.domain.trim() ? "Enter a domain to continue." : nameProblem && "Fix the domain to continue.",
          body: (
            <Field label="Domain" hint={nameHint} error={draft.domain.trim() !== "" && nameProblem}>
              {(p) => <input {...p} data-autofocus placeholder="pay.example.com" autoComplete="off" spellCheck={false} value={draft.domain} onChange={(e) => set({ domain: e.target.value })} />}
            </Field>
          ),
        },
        {
          title: "Registration",
          blocker: problems.maxPerSession && "Fix the per-wallet limit to continue.",
          body: <RegistrationFields draft={draft} set={set} problems={problems} />,
        },
        {
          title: "Names & amounts",
          blocker: anyProblem({ ...problems, maxPerSession: undefined }) ? "Fix the highlighted fields to continue." : undefined,
          body: <><NameFields draft={draft} set={set} problems={problems} /><AmountFields draft={draft} set={set} problems={problems} server={server} /></>,
        },
        {
          title: "Review",
          body: (
            <>
              <dl className="kv">
                <dt>Domain</dt><dd><strong>{name}</strong></dd>
                <dt>Who can get an address</dt><dd>{draft.modes.length ? MODES.filter((m) => draft.modes.includes(m.id)).map((m) => m.title).join(", ") : "Only names you assign"}</dd>
                <dt>API key</dt><dd>{draft.requireApiKey ? "Required to register" : "Not required"}</dd>
                <dt>Per wallet</dt><dd>{draft.maxPerSession.trim() ? `Up to ${plural(Number(draft.maxPerSession), "address", "addresses")}` : "No limit"}</dd>
                <dt>Names</dt><dd>{draft.minLen}–{draft.maxLen} characters from <code>{draft.charset.trim()}</code></dd>
                <dt>Amounts</dt><dd>{amountText(intOrNull(draft.minSendable), intOrNull(draft.maxSendable))}</dd>
              </dl>
              <Check toggle title="Enabled" description="Off creates it switched off; turn it on later with Edit." checked={draft.enabled} onChange={(on) => set({ enabled: on })} />
            </>
          ),
        },
      ]} />
  );
}

function EditDomain({ domain, server, onClose, onSaved }: { domain: Domain; server: ServerLimits; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(() => draftOf(domain));
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const problems = problemsOf(draft);
  const blocked = anyProblem(problems);
  const changed = JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(draftOf(domain)));
  const save = async () => {
    if (blocked || !changed) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.patch(`/domains/${domain.id}`, bodyOf(draft));
      toast(`${domain.domain} saved`);
      onSaved();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Edit ${domain.domain}`} wide onClose={onClose} onSubmit={() => void save()}
      footer={
        <>
          <span className="why" role="status">{blocked ? "Fix the highlighted fields to save." : !changed ? "Nothing changed yet." : ""}</span>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || blocked || !changed}>{busy ? "Saving…" : "Save changes"}</button>
        </>
      }>
      {error && <Alert tone="bad">{error}</Alert>}
      <Check toggle title="Enabled" description="Off takes every address on this domain offline." checked={draft.enabled} onChange={(on) => set({ enabled: on })} />
      <h3>Registration</h3>
      <RegistrationFields draft={draft} set={set} problems={problems} />
      <h3>Names</h3>
      <NameFields draft={draft} set={set} problems={problems} />
      <h3>Amounts</h3>
      <AmountFields draft={draft} set={set} problems={problems} server={server} />
    </Dialog>
  );
}

interface SectionProps { draft: Draft; set: (patch: Partial<Draft>) => void; problems: Problems }

function RegistrationFields({ draft, set, problems }: SectionProps) {
  return (
    <>
      <fieldset>
        <legend>Who can get an address</legend>
        <div className="choices">
          {MODES.map((m) => (
            <Check key={m.id} title={m.title} description={m.description} checked={draft.modes.includes(m.id)}
              onChange={(on) => set({ modes: on ? [...draft.modes, m.id] : draft.modes.filter((x) => x !== m.id) })} />
          ))}
        </div>
        {!draft.modes.length && <p className="field-hint">With none ticked, wallets only get names you mint, reserve or hand out claim codes for.</p>}
      </fieldset>
      <Check toggle title="Require API key" description="Wallets must send a key from API keys to register here." checked={draft.requireApiKey} onChange={(on) => set({ requireApiKey: on })} />
      <Field label="Addresses per wallet" hint="Most active addresses one wallet can hold here. Empty means no limit." error={problems.maxPerSession}>
        {(p) => <input {...p} type="number" min={1} step={1} placeholder="No limit" value={draft.maxPerSession} onChange={(e) => set({ maxPerSession: e.target.value })} />}
      </Field>
    </>
  );
}

const CHARSETS = [
  { value: "a-z0-9._-", label: "Letters, digits, dot, underscore, hyphen" },
  { value: "a-z0-9_-", label: "Letters, digits, underscore, hyphen" },
  { value: "a-z0-9", label: "Letters and digits only" },
];

function NameFields({ draft, set, problems }: SectionProps) {
  const [sample, setSample] = useState("");
  const listId = useId();
  const rulesOk = !problems.minLen && !problems.maxLen && !problems.charset;
  const verdict = sample && rulesOk
    ? usernameProblem(sample.toLowerCase(), { usernameMinLen: Number(draft.minLen), usernameMaxLen: Number(draft.maxLen), usernamePattern: draft.charset.trim() })
    : undefined;
  return (
    <>
      <div className="field-row">
        <Field label="Shortest name" error={problems.minLen}>
          {(p) => <input {...p} type="number" min={1} step={1} value={draft.minLen} onChange={(e) => set({ minLen: e.target.value })} />}
        </Field>
        <Field label="Longest name" error={problems.maxLen}>
          {(p) => <input {...p} type="number" min={1} step={1} value={draft.maxLen} onChange={(e) => set({ maxLen: e.target.value })} />}
        </Field>
      </div>
      <Field label="Allowed characters" error={problems.charset}
        hint={<>A regex character set: <code>a-z0-9._-</code> is lowercase letters, digits, dot, underscore and hyphen.</>}>
        {(p) => (
          <>
            <input {...p} className="mono" list={listId} autoComplete="off" spellCheck={false} value={draft.charset} onChange={(e) => set({ charset: e.target.value })} />
            <datalist id={listId}>{CHARSETS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</datalist>
          </>
        )}
      </Field>
      <div className="field">
        <Field label="Try a name" hint={sample ? undefined : "Check any name against these rules."}>
          {(p) => <input {...p} placeholder="alice" autoComplete="off" value={sample} onChange={(e) => setSample(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }} />}
        </Field>
        {sample && rulesOk && <Checks items={[{ state: verdict ? "fail" : "pass", text: verdict ?? `“${sample.toLowerCase()}” is allowed` }]} />}
      </div>
    </>
  );
}

function AmountFields({ draft, set, problems, server }: SectionProps & { server: ServerLimits }) {
  const hint = (raw: string, fallback?: number) =>
    raw.trim() ? `= ${sats(Number(raw))}` : fallback !== undefined ? `Empty uses the server's ${sats(fallback)}` : "Empty uses the server setting";
  return (
    <div className="field-row">
      <Field label="Smallest payment (msat)" hint={hint(draft.minSendable, server?.min)} error={problems.minSendable}>
        {(p) => <input {...p} type="number" min={1} step={1} placeholder={server ? num(server.min) : "Server setting"} value={draft.minSendable} onChange={(e) => set({ minSendable: e.target.value })} />}
      </Field>
      <Field label="Largest payment (msat)" hint={hint(draft.maxSendable, server?.max)} error={problems.maxSendable}>
        {(p) => <input {...p} type="number" min={1} step={1} placeholder={server ? num(server.max) : "Server setting"} value={draft.maxSendable} onChange={(e) => set({ maxSendable: e.target.value })} />}
      </Field>
    </div>
  );
}
