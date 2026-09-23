import { spawn } from "node:child_process";
import type { EnclaveAttestor } from "./attestor.js";

// A Nitro document is a few kilobytes; base64 adds a third.
const MAX_OUTPUT = 64 * 1024;
const MAX_REASON = 4 * 1024;

/** Quotes through the NSM helper (attestor/cmd/lnurl-attest), one process per quote. The helper
 *  gets an empty environment: it needs none, and this process's holds keys. */
export function nsmAttestor(command: string, args: readonly string[] = [], opts: { timeoutMs?: number } = {}): EnclaveAttestor {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    quote: ({ nonce, userData }) => new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      let output = "";
      let reason = "";
      const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], env: {}, windowsHide: true });
      const finish = (error: Error | undefined, document?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          child.kill("SIGKILL");
          reject(error);
        } else {
          resolve(document!);
        }
      };
      const timer = setTimeout(() => finish(new Error(`NSM helper timed out after ${timeoutMs} ms`)), timeoutMs);

      child.on("error", (error) => finish(new Error(`NSM helper ${command} could not start: ${error.message}`)));
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
        if (output.length > MAX_OUTPUT) finish(new Error(`NSM helper wrote more output than a document (over ${MAX_OUTPUT} bytes)`));
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (reason.length < MAX_REASON) reason += chunk;
      });
      child.on("close", (code, signal) => {
        if (code !== 0) {
          finish(new Error(`NSM helper exited ${code ?? signal}: ${reason.trim() || "no reason given"}`));
          return;
        }
        const text = output.trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
          finish(new Error("NSM helper returned no document"));
          return;
        }
        finish(undefined, new Uint8Array(Buffer.from(text, "base64")));
      });
      // A helper that exits before reading its input breaks the pipe; its exit says why.
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({ nonce: Buffer.from(nonce).toString("base64"), userData: Buffer.from(userData).toString("base64") }));
    }),
  };
}
