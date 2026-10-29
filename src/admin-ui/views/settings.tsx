import { Fragment, useState } from "react";
import { api, type SettingKey, type SettingView, type SettingsResponse } from "../api.js";
import { duration, intProblem, num, sats } from "../lib.js";
import { Badge, LoadError, Loading, Page, useAction, useLoad, type Tone } from "../ui.js";

type Kind = "msat" | "ms" | "perMinute" | "url";
interface Spec { key: SettingKey; label: string; help: string; env: string; kind: Kind }

const EDITABLE: Spec[] = [
  { key: "minSendable", label: "Min sendable", help: "Smallest payment payers can send. Domains can set their own.", env: "MIN_SENDABLE", kind: "msat" },
  { key: "maxSendable", label: "Max sendable", help: "Largest payment payers can send. Domains can set their own.", env: "MAX_SENDABLE", kind: "msat" },
  { key: "invoiceTimeoutMs", label: "Invoice timeout", help: "How long a payer waits for a connected wallet to return an invoice.", env: "INVOICE_TIMEOUT_MS", kind: "ms" },
  { key: "registrationRateLimitPerMin", label: "Registration rate limit", help: "Address registrations one IP can make per minute.", env: "REGISTRATION_RATE_LIMIT", kind: "perMinute" },
  { key: "baseUrl", label: "Base URL", help: "Public URL of this server, used in the LNURLs, callbacks and verify links it hands out.", env: "BASE_URL", kind: "url" },
];

const READ_ONLY: Record<string, { label: string; env: string }> = {
  port: { label: "Public port", env: "PORT" },
  adminPort: { label: "Admin port", env: "ADMIN_PORT" },
  adminBind: { label: "Admin listens on", env: "ADMIN_BIND" },
  dbPath: { label: "Database file", env: "DB_PATH" },
  trustProxy: { label: "Trusted proxy hops", env: "TRUST_PROXY" },
  bootstrapDomain: { label: "Bootstrap domain", env: "BOOTSTRAP_DOMAIN" },
  tokenEncryptionKey: { label: "Token encryption key", env: "TOKEN_ENCRYPTION_KEY" },
};

const KEY_STATE: Record<string, { tone: Tone; text: string }> = {
  set: { tone: "ok", text: "Set" },
  "insecure fallback": { tone: "warn", text: "Insecure fallback (development only)" },
  unset: { tone: "bad", text: "Not set" },
};

const unit = (kind: Kind, n: number) =>
  kind === "msat" ? `${num(n)} msat (${sats(n)})` : kind === "ms" ? `${num(n)} ms (${duration(n)})` : `${num(n)} per minute`;
const shown = (spec: Spec, value: number | string) => (spec.kind === "url" ? String(value) : unit(spec.kind, Number(value)));

export function Settings() {
  const data = useLoad(() => api.get<SettingsResponse>("/settings"), []);
  const editable = data.data?.editable ?? {};
  return (
    <Page title="Settings" intro="Server-wide defaults. A value saved here applies at once, with no restart, until you reset it.">
      {data.error && <LoadError error={data.error} retry={data.reload} />}
      {data.loading ? <Loading what="settings" /> : data.data && (
        <>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Setting</th><th>In effect</th><th>New value</th><th /></tr></thead>
              <tbody>
                {EDITABLE.map((spec) => {
                  const view = editable[spec.key];
                  return view && <SettingRow key={spec.key} spec={spec} view={view} editable={editable} onChanged={data.reload} />;
                })}
              </tbody>
            </table>
          </div>
          <section className="section">
            <div className="section-head">
              <h2>From the environment</h2>
              <p className="small">Read-only here. Change the variable and restart to update one.</p>
            </div>
            <div className="panel">
              <dl className="kv">
                {Object.entries(data.data.readOnly).map(([key, value]) => {
                  const meta = READ_ONLY[key];
                  const keyState = key === "tokenEncryptionKey" ? KEY_STATE[String(value)] : undefined;
                  return (
                    <Fragment key={key}>
                      <dt>{meta?.label ?? key}{meta && <span className="sub"><code>{meta.env}</code></span>}</dt>
                      <dd>
                        {keyState ? <Badge tone={keyState.tone}>{keyState.text}</Badge>
                          : value === null ? <span className="muted">Not set</span>
                          : typeof value === "boolean" ? (value ? "On" : "Off")
                          : String(value)}
                      </dd>
                    </Fragment>
                  );
                })}
              </dl>
            </div>
          </section>
        </>
      )}
    </Page>
  );
}

function SettingRow({ spec, view, editable, onChanged }: {
  spec: Spec;
  view: SettingView;
  editable: SettingsResponse["editable"];
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const { run, busy } = useAction();
  const raw = draft.trim();
  const n = Number(raw);
  const min = Number(editable.minSendable?.value);
  const max = Number(editable.maxSendable?.value);
  const problem = !raw ? undefined
    : spec.kind === "url" ? (/^https?:\/\/.+/.test(raw) ? undefined : "Enter an http(s) URL.")
    : intProblem(raw)
      ?? (spec.key === "minSendable" && n > max ? `Can't exceed Max sendable (${num(max)} msat).` : undefined)
      ?? (spec.key === "maxSendable" && n < min ? `Can't be below Min sendable (${num(min)} msat).` : undefined);

  const save = () => {
    if (!raw || problem) return;
    void run(async () => {
      await api.patch("/settings", { [spec.key]: spec.kind === "url" ? raw : n });
      setDraft("");
      await onChanged();
    }, `${spec.label} saved`);
  };
  const reset = () => void run(async () => { await api.del(`/settings/${spec.key}`); await onChanged(); }, `${spec.label} back to its default`);

  return (
    <tr>
      <td><strong>{spec.label}</strong><span className="sub">{spec.help}</span></td>
      <td>
        <span className="nowrap">{shown(spec, view.value)}</span>
        {view.overridden && <> <Badge tone="info" title="Saved here; Reset returns to the environment value">Overridden</Badge></>}
        <span className="sub">Default from <code>{spec.env}</code>: {shown(spec, view.default)}</span>
      </td>
      <td>
        <input aria-label={`New value for ${spec.label}`} aria-invalid={problem ? true : undefined}
          type={spec.kind === "url" ? "url" : "number"} min={spec.kind === "url" ? undefined : 1} step={spec.kind === "url" ? undefined : 1}
          placeholder={String(view.value)} value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        {problem ? <span className="sub field-error">{problem}</span>
          : raw && spec.kind !== "url" ? <span className="sub">{unit(spec.kind, n)}</span> : null}
      </td>
      <td className="actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !raw || Boolean(problem)} onClick={save}>Save</button>
        {view.overridden && <button type="button" className="btn btn-sm" disabled={busy} onClick={reset}>Reset</button>}
      </td>
    </tr>
  );
}
