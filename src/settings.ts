import type { SettingsRepo } from "./db/repositories/settings.js";

/** The runtime-soft settings the server reads per request (so DB overrides take effect live). */
export interface RuntimeSettings {
  minSendable(): number;
  maxSendable(): number;
  invoiceTimeoutMs(): number;
  baseUrl(): string;
  registrationRateLimitPerMin(): number;
}

export interface SettingsDefaults {
  minSendable: number;
  maxSendable: number;
  invoiceTimeoutMs: number;
  baseUrl: string;
  registrationRateLimitPerMin: number;
}

export const EDITABLE_SETTING_KEYS = [
  "minSendable",
  "maxSendable",
  "invoiceTimeoutMs",
  "baseUrl",
  "registrationRateLimitPerMin",
] as const;
export type SettingKey = (typeof EDITABLE_SETTING_KEYS)[number];

export function isSettingKey(k: string): k is SettingKey {
  return (EDITABLE_SETTING_KEYS as readonly string[]).includes(k);
}

export class SettingsError extends Error {}

/** RuntimeSettings backed by fixed values — used when persistence is disabled (no DB). */
export function staticSettings(d: SettingsDefaults): RuntimeSettings {
  return {
    minSendable: () => d.minSendable,
    maxSendable: () => d.maxSendable,
    invoiceTimeoutMs: () => d.invoiceTimeoutMs,
    baseUrl: () => d.baseUrl,
    registrationRateLimitPerMin: () => d.registrationRateLimitPerMin,
  };
}

/** Effective settings = env defaults, overridden by DB values; overrides editable at runtime. */
export class SettingsService implements RuntimeSettings {
  private overrides: Record<string, string>;
  constructor(private repo: SettingsRepo, private defaults: SettingsDefaults) {
    this.overrides = repo.getAll();
  }

  private num(key: SettingKey, fallback: number): number {
    const v = this.overrides[key];
    return v === undefined ? fallback : Number(v);
  }

  minSendable() { return this.num("minSendable", this.defaults.minSendable); }
  maxSendable() { return this.num("maxSendable", this.defaults.maxSendable); }
  invoiceTimeoutMs() { return this.num("invoiceTimeoutMs", this.defaults.invoiceTimeoutMs); }
  registrationRateLimitPerMin() { return this.num("registrationRateLimitPerMin", this.defaults.registrationRateLimitPerMin); }
  baseUrl() { return this.overrides.baseUrl ?? this.defaults.baseUrl; }

  /** Set an override (validated). */
  set(key: SettingKey, value: unknown): void {
    this.repo.set(key, this.validate(key, value));
    this.overrides = this.repo.getAll();
  }

  /** Clear an override → reverts to the env default. */
  clear(key: SettingKey): void {
    this.repo.clear(key);
    this.overrides = this.repo.getAll();
  }

  private validate(key: SettingKey, value: unknown): string {
    if (key === "baseUrl") {
      if (typeof value !== "string" || !/^https?:\/\/.+/.test(value)) throw new SettingsError("baseUrl must be an http(s) URL");
      return value;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new SettingsError(`${key} must be a positive integer`);
    return String(n);
  }

  /** Snapshot for the admin API: effective value, env default, and whether overridden. */
  view(): Record<SettingKey, { value: number | string; default: number | string; overridden: boolean }> {
    const row = (key: SettingKey, value: number | string, dflt: number | string) => ({
      value,
      default: dflt,
      overridden: this.overrides[key] !== undefined,
    });
    return {
      minSendable: row("minSendable", this.minSendable(), this.defaults.minSendable),
      maxSendable: row("maxSendable", this.maxSendable(), this.defaults.maxSendable),
      invoiceTimeoutMs: row("invoiceTimeoutMs", this.invoiceTimeoutMs(), this.defaults.invoiceTimeoutMs),
      baseUrl: row("baseUrl", this.baseUrl(), this.defaults.baseUrl),
      registrationRateLimitPerMin: row("registrationRateLimitPerMin", this.registrationRateLimitPerMin(), this.defaults.registrationRateLimitPerMin),
    };
  }
}
