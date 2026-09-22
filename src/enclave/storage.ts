export interface EnclaveStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  load(key: string): Promise<Uint8Array | undefined>;
}

type Fetch = typeof fetch;

/** A checkpoint that never returns is worse than one that fails: the store
 *  coalesces onto a request in flight, so one hung call would stall every later
 *  flush and every caller waiting on a barrier. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class EnclaveStorageClient implements EnclaveStorage {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl: string; token: string; fetchImpl?: Fetch; timeoutMs?: number }) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const response = await this.send(this.url(key), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" },
      body: Buffer.from(data),
    }, `PUT ${key}`);
    await assertOk(response, `PUT ${key}`);
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    const response = await this.send(this.url(key), {
      headers: { authorization: `Bearer ${this.token}` },
    }, `GET ${key}`);
    if (response.status === 404) return undefined;
    await assertOk(response, `GET ${key}`);
    const body = await response.arrayBuffer();
    return new Uint8Array(body);
  }

  private async send(url: string, init: RequestInit, operation: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const reason = (error as Error).name === "TimeoutError"
        ? `timed out after ${this.timeoutMs}ms`
        : (error as Error).message;
      throw new Error(`enclave storage ${operation}: ${reason}`);
    }
  }

  private url(key: string): string {
    const path = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.baseUrl.replace(/\/$/, "")}/v1/storage/${path}`;
  }
}

async function assertOk(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`enclave storage ${operation}: HTTP ${response.status}${body ? `: ${body}` : ""}`);
}
