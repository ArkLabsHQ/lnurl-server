/** Separate from checkpoint.ts so loading config does not pull in node:sqlite. */
export function checkpointPrefix(key: string): string {
  if (!/^[a-z0-9][a-z0-9/_.-]*[a-z0-9]$/.test(key) || key.includes("//") || key.includes("..")) {
    throw new Error("invalid ENCLAVE_CHECKPOINT_KEY");
  }
  return key;
}
