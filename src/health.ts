export interface ComponentHealth { ok: boolean; detail?: string }
export interface HealthCheckOptions { required?: boolean }

interface RegisteredCheck {
  check: () => ComponentHealth;
  required: boolean;
}

export class HealthRegistry {
  private accepting = true;
  private reason?: string;
  private checks = new Map<string, RegisteredCheck>();

  register(name: string, check: () => ComponentHealth, options: HealthCheckOptions = {}): void {
    this.checks.set(name, { check, required: options.required ?? true });
  }
  beginShutdown(reason: string): void { this.accepting = false; this.reason = reason; }
  live(): boolean { return true; }
  ready(): boolean { return this.accepting && [...this.checks.values()].every(({ check, required }) => !required || check().ok); }
  snapshot(): { status: "ready" | "unready"; components: Record<string, ComponentHealth>; reason?: string } {
    const states = [...this.checks].map(([name, { check, required }]) => ({ name, state: check(), required }));
    const components = Object.fromEntries(states.map(({ name, state }) => [name, state]));
    return {
      status: this.accepting && states.every(({ state, required }) => !required || state.ok) ? "ready" : "unready",
      components,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
