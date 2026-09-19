import { readFileSync } from "node:fs";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site under /<repo>/, so assets need that prefix;
// local dev and any root-served host need "/". Set by the Pages workflow rather
// than hardcoded, so running `vite` here still works without it.
const base = process.env.DEMO_WALLET_BASE ?? "/";

// Opt-in so the debugging page never reaches Pages: the Pages workflow does not
// set it, so the published bundle has one entry as before.
const scratch = process.env.DEMO_WALLET_SCRATCH === "1";

// The local-stack solver sends no CORS headers, so a browser cannot post an RFQ
// to it directly. Dev/preview only — it proxies nothing in a built bundle, and
// deployed solvers are reached over nostr, which is not preflighted.
const solver = process.env.DEMO_WALLET_SOLVER_PROXY;
const proxy = solver
  ? { "/solver": { target: solver, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/solver/, "") } }
  : undefined;

// The stack's solver is not in any published registry — its card exists only in
// the file the harness writes. Read per request, not at startup: the preview
// server is up before the global setup that writes it.
const registryFile = process.env.DEMO_WALLET_SOLVER_REGISTRY;
function localRegistry(): Plugin {
  const serve = (server: ViteDevServer | { middlewares: ViteDevServer["middlewares"] }) => {
    server.middlewares.use("/solver-registry.json", (_req, res) => {
      try {
        res.setHeader("content-type", "application/json");
        res.end(readFileSync(registryFile!, "utf8"));
      } catch {
        res.statusCode = 503;
        res.end('{"error":"registry not written yet"}');
      }
    });
  };
  return { name: "local-solver-registry", configureServer: serve, configurePreviewServer: serve };
}

export default defineConfig({
  base,
  plugins: [react(), ...(registryFile ? [localRegistry()] : [])],
  server: { port: 5173, ...(proxy ? { proxy } : {}) },
  ...(proxy ? { preview: { proxy } } : {}),
  ...(scratch
    ? { build: { rollupOptions: { input: { main: "index.html", scratch: "scratch.html" } } } }
    : {}),
});
