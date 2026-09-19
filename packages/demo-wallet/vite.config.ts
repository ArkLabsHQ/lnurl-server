import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serves a project site under /<repo>/, so assets need that prefix;
// local dev and any root-served host need "/". Set by the Pages workflow rather
// than hardcoded, so running `vite` here still works without it.
const base = process.env.DEMO_WALLET_BASE ?? "/";

// Opt-in so the debugging page never reaches Pages: the Pages workflow does not
// set it, so the published bundle has one entry as before.
const scratch = process.env.DEMO_WALLET_SCRATCH === "1";

export default defineConfig({
  base,
  plugins: [react()],
  server: { port: 5173 },
  ...(scratch
    ? { build: { rollupOptions: { input: { main: "index.html", scratch: "scratch.html" } } } }
    : {}),
});
