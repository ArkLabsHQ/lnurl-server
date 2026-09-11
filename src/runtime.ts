import type { Server } from "node:http";
import type { HealthRegistry } from "./health.js";

interface Closeable { close(): void | Promise<void> }

export interface Runtime {
  addServer(server: Server): void;
  addStop(stop: () => void): void;
  addTransport(transport: Closeable): void;
  setDatabase(db: Closeable): void;
  shutdown(reason: string): Promise<void>;
  resources(): { servers: number; timers: number; transports: number; dbOpen: boolean };
}

export function createRuntime(health: HealthRegistry, shutdownTimeoutMs = 15_000): Runtime {
  const servers = new Set<Server>();
  const stops = new Set<() => void>();
  const transports = new Set<Closeable>();
  let database: Closeable | undefined;
  let closing: Promise<void> | undefined;

  return {
    addServer: (server) => { servers.add(server); },
    addStop: (stop) => { stops.add(stop); },
    addTransport: (transport) => { transports.add(transport); },
    setDatabase: (db) => { database = db; },
    resources: () => ({ servers: servers.size, timers: stops.size, transports: transports.size, dbOpen: Boolean(database) }),
    shutdown(reason) {
      if (closing) return closing;
      health.beginShutdown(reason);
      closing = (async () => {
        for (const stop of stops) stop();
        stops.clear();
        await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
          const force = setTimeout(() => server.closeAllConnections?.(), shutdownTimeoutMs);
          force.unref?.();
          server.close(() => { clearTimeout(force); resolve(); });
          server.closeIdleConnections?.();
        })));
        servers.clear();
        await Promise.allSettled([...transports].map((transport) => transport.close()));
        transports.clear();
        await database?.close();
        database = undefined;
      })();
      return closing;
    },
  };
}
