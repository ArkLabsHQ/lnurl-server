import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/admin-ui",
  base: "./",
  plugins: [react()],
  build: { outDir: resolve(__dirname, "dist/admin-ui"), emptyOutDir: true },
  server: { proxy: { "/admin/api": "http://127.0.0.1:3001" } },
});
