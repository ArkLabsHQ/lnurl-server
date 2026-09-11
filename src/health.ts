export interface ComponentHealth { ok: boolean; detail?: string }

export class HealthRegistry {
  private accepting = true;
  private reason?: string;
  private checks = new Map<string, () => ComponentHealth>();

  register(name: string, check: () => ComponentHealth): void { this.checks.set(name, check); }
  beginShutdown(reason: string): void { this.accepting = false; this.reason = reason; }
  live(): boolean { return true; }
  ready(): boolean { return this.accepting && [...this.checks.values()].every((check) => check().ok); }
  snapshot(): { status: "ready" | "unready"; components: Record<string, ComponentHealth>; reason?: string } {
    const components = Object.fromEntries([...this.checks].map(([name, check]) => [name, check()]));
    return {
      status: this.accepting && Object.values(components).every((state) => state.ok) ? "ready" : "unready",
      components,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
