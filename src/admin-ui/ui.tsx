import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { errMsg } from "./api.js";

export type Tone = "ok" | "warn" | "bad" | "off" | "info";

// ---------- Routing (the hash, so reloads, links and the back button all work)

export type Params = Record<string, string | number | undefined>;

export function href(path: string, params: Params = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

export const navigate = (path: string, params?: Params): void => {
  location.hash = href(path, params);
};

export function useHashRoute(): { path: string; query: URLSearchParams } {
  const read = () => {
    const raw = location.hash.replace(/^#/, "");
    const at = raw.indexOf("?");
    const path = `/${(at < 0 ? raw : raw.slice(0, at)).replace(/^\/+|\/+$/g, "")}`;
    return { path, query: new URLSearchParams(at < 0 ? "" : raw.slice(at + 1)) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

// ---------- Data

/** Loads on mount and whenever `deps` change; `pollMs` re-reads while the tab is visible. A slower,
 *  older response never overwrites a newer one. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[], pollMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [updatedAt, setUpdatedAt] = useState<number>();
  const latest = useRef(load);
  latest.current = load;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await latest.current();
      if (mine !== seq.current) return;
      setData(next);
      setError(undefined);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);
  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const timer = setInterval(() => { if (!document.hidden) void reload(); }, pollMs);
    return () => clearInterval(timer);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload, updatedAt, loading: data === undefined && error === undefined };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

// ---------- Toasts

type ToastTone = "ok" | "warn" | "bad";
const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; tone: ToastTone }>>([]);
  const nextId = useRef(0);
  const push = useCallback((text: string, tone: ToastTone = "ok") => {
    const id = ++nextId.current;
    setToasts((all) => [...all, { id, text, tone }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === "ok" ? 4000 : 8000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

/** Runs a row action, toasting its outcome so a click never fails silently. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true);
    try {
      await work();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast(errMsg(e), "bad");
      return false;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

// ---------- Dialogs

export function Dialog({ title, onClose, onSubmit, footer, steps, wide, children }: {
  title: string;
  onClose: () => void;
  onSubmit?: () => void;
  footer?: ReactNode;
  steps?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => dialog.close();
  }, []);
  const frame = (
    <>
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {steps}
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </>
  );
  return (
    <dialog ref={ref} className={wide ? "dialog wide" : "dialog"} aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {onSubmit
        ? <form className="dialog-frame" noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>{frame}</form>
        : <div className="dialog-frame">{frame}</div>}
    </dialog>
  );
}

export interface WizardStep {
  title: string;
  body: ReactNode;
  /** Why Next is unavailable; shown beside the button instead of leaving it mysteriously grey. */
  blocker?: string;
}

export function Wizard({ title, steps, finishLabel, onFinish, onClose, busy, error }: {
  title: string;
  steps: WizardStep[];
  finishLabel: string;
  onFinish: () => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const [at, setAt] = useState(0);
  const step = steps[Math.min(at, steps.length - 1)]!;
  const last = at >= steps.length - 1;
  useEffect(() => {
    document.querySelector<HTMLElement>("dialog[open] .dialog-body [data-autofocus]")?.focus();
  }, [at]);
  const next = () => {
    if (step.blocker || busy) return;
    if (last) onFinish();
    else setAt(at + 1);
  };
  return (
    <Dialog title={title} onClose={onClose} onSubmit={next} wide
      steps={
        <ol className="steps" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.title} className={i < at ? "done" : undefined} aria-current={i === at ? "step" : undefined}>
              <span className="step-num" aria-hidden="true">{i < at ? "✓" : i + 1}</span>
              {s.title}
            </li>
          ))}
        </ol>
      }
      footer={
        <>
          <span className="why" role="status">{step.blocker}</span>
          {at > 0 && <button type="button" className="btn" disabled={busy} onClick={() => setAt(at - 1)}>Back</button>}
          <button type="submit" className="btn btn-primary" disabled={Boolean(step.blocker) || busy}>
            {busy ? "Working…" : last ? finishLabel : "Next"}
          </button>
        </>
      }>
      {error && last && <Alert tone="bad">{error}</Alert>}
      {step.body}
    </Dialog>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Typed back before the button unlocks, for actions that take a lot with them. */
  typeToConfirm?: string;
}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<ConfirmOptions & { resolve: (ok: boolean) => void }>();
  const [typed, setTyped] = useState("");
  const ask = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => {
    setTyped("");
    setOpen({ ...o, resolve });
  }), []);
  const answer = (ok: boolean) => {
    open?.resolve(ok);
    setOpen(undefined);
  };
  const locked = Boolean(open?.typeToConfirm) && typed.trim() !== open?.typeToConfirm;
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {open && (
        <Dialog title={open.title} onClose={() => answer(false)} onSubmit={() => { if (!locked) answer(true); }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => answer(false)} data-autofocus={open.typeToConfirm ? undefined : true}>Cancel</button>
              <button type="submit" className={open.danger ? "btn btn-danger-solid" : "btn btn-primary"} disabled={locked}>{open.confirmLabel}</button>
            </>
          }>
          <div>{open.body}</div>
          {open.typeToConfirm && (
            <Field label={<>Type <code>{open.typeToConfirm}</code> to confirm</>}>
              {(p) => <input {...p} data-autofocus autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
            </Field>
          )}
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

/** Shows a value the server will never return again, with the means to copy it. */
export function SecretDialog({ title, label, secret, children, onClose }: {
  title: string;
  label: string;
  secret: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog title={title} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      {children}
      <Field label={label} hint="Copy it now. This is the only time it is shown.">
        {(p) => (
          <div className="secret">
            <input {...p} readOnly value={secret} onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={secret} autoFocus />
          </div>
        )}
      </Field>
    </Dialog>
  );
}

// ---------- Layout and display

export function Page({ title, intro, actions, children }: { title: string; intro?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} – lnurl admin`;
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <>
      <header className="page-head">
        <div>
          <h1 ref={heading} tabIndex={-1}>{title}</h1>
          {intro && <p className="page-intro">{intro}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
      {children}
    </>
  );
}

export function Field({ label, hint, error, className, children }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | false;
  className?: string;
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error || hint;
  return (
    <div className={className ? `field ${className}` : "field"}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": note ? noteId : undefined, "aria-invalid": error ? true : undefined })}
      {error ? <p id={noteId} className="field-error">{error}</p> : hint ? <p id={noteId} className="field-hint">{hint}</p> : null}
    </div>
  );
}

/** A checkbox, radio or switch with its title and a one-line description, the whole card clickable. */
export function Check({ type = "checkbox", toggle, plain, name, checked, disabled, autoFocus, title, description, onChange }: {
  type?: "checkbox" | "radio";
  toggle?: boolean;
  plain?: boolean;
  name?: string;
  checked: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  title: string;
  description?: ReactNode;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className={plain ? "check plain" : "check"}>
      <input type={type} name={name} className={toggle ? "switch" : undefined} checked={checked} disabled={disabled}
        data-autofocus={autoFocus || undefined}
        aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span id={`${id}-title`} className="check-title">{title}</span>
        {description && <span id={`${id}-desc`} className="check-desc">{description}</span>}
      </span>
    </label>
  );
}

export type CheckState = "pass" | "fail" | "wait" | "note";
export const Checks = ({ items }: { items: Array<{ state: CheckState; text: string }> }) => (
  <ul className="checks" aria-live="polite">
    {items.map((c) => <li key={c.text} className={c.state}>{c.text}</li>)}
  </ul>
);

export const Badge = ({ tone, title, children }: { tone: Tone; title?: string; children: ReactNode }) => (
  <span className={`badge ${tone}`} title={title}>{children}</span>
);

export function Alert({ tone, title, action, children }: { tone: Tone; title?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`alert ${tone}`} role={tone === "bad" ? "alert" : undefined}>
      <div>
        {title && <p className="alert-title">{title}</p>}
        {children}
      </div>
      {action}
    </div>
  );
}

/** A failed load, with a way to try again. */
export const LoadError = ({ error, retry }: { error: Error; retry: () => void }) => (
  <Alert tone="bad" title="Couldn't load this" action={<button type="button" className="btn btn-sm" onClick={retry}>Try again</button>}>
    <p>{error.message}</p>
  </Alert>
);

export const Empty = ({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="empty">
    <p className="empty-title">{title}</p>
    {children && <p className="empty-text">{children}</p>}
    {action}
  </div>
);

export const Loading = ({ what }: { what: string }) => <p className="loading">Loading {what}…</p>;

// The Clipboard API is missing outside a secure context (the admin over plain http on a LAN address).
const writeClipboard = (value: string): Promise<void> => Promise.resolve().then(() => navigator.clipboard.writeText(value));

export function CopyButton({ value, label = "Copy", autoFocus }: { value: string; label?: string; autoFocus?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () =>
    writeClipboard(value).then(
      () => setState("copied"),
      () => setState("failed"),
    ).finally(() => setTimeout(() => setState("idle"), 2000));
  return (
    <button type="button" className="btn" onClick={() => void copy()} data-autofocus={autoFocus || undefined}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed: select it" : label}
    </button>
  );
}

/** A long value shown short; a click copies all of it. */
export function Copyable({ value, length }: { value: string; length: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => writeClipboard(value).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, () => window.prompt("Copy it from here:", value));
  return (
    <button type="button" className="copyable" title={`${value}\nClick to copy`} aria-label={`Copy ${value}`} onClick={() => void copy()}>
      {copied ? "Copied" : value.length > length ? `${value.slice(0, length)}…` : value}
    </button>
  );
}
