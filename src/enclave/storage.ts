export interface EnclaveStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  load(key: string): Promise<Uint8Array | undefined>;
}

type Fetch = typeof fetch;

export class EnclaveStorageClient implements EnclaveStorage {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: Fetch;

  constructor(options: { baseUrl: string; token: string; fetchImpl?: Fetch }) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const response = await this.fetchImpl(this.url(key), {
      method: "PUT",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream" },
      body: Buffer.from(data),
    });
    await assertOk(response, `PUT ${key}`);
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    const response = await this.fetchImpl(this.url(key), {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (response.status === 404) return undefined;
    await assertOk(response, `GET ${key}`);
    const body = await response.arrayBuffer();
    return new Uint8Array(body);
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
