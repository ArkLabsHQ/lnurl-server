import { UpstreamError } from "./errors.js";

export const BOOT_PROBE_TIMEOUT_MS = 15_000;

export async function probeBootEndpoint(
  url: string,
  service: string,
  timeoutMs = BOOT_PROBE_TIMEOUT_MS,
): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError(service, response.status);
  }
  return response;
}
