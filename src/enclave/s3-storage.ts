import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { EnclaveStorage } from "./storage.js";

/** Matches the runtime's own AWS client timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The design's LNURL-owned adapter: objects in a bucket given to this deployment,
 * reached with whatever the SDK's default credential chain finds. Inside Enclave
 * that is the instance role through the runtime's IMDS forwarder, which the runtime
 * advertises as AWS_EC2_METADATA_SERVICE_ENDPOINT. The host can withhold or delete
 * objects, but everything stored here is sealed and authenticated first.
 */
export class S3Storage implements EnclaveStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly timeoutMs: number;

  constructor(options: { client: S3Client; bucket: string; timeoutMs?: number }) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      throw storageError(`PUT ${key}`, error, this.timeoutMs);
    }
  }

  async load(key: string): Promise<Uint8Array | undefined> {
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      return out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw storageError(`GET ${key}`, error, this.timeoutMs);
    }
  }
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

function storageError(operation: string, error: unknown, timeoutMs: number): Error {
  const e = error as Error | undefined;
  const timedOut = e?.name === "AbortError" || e?.name === "TimeoutError";
  return new Error(`enclave storage ${operation}: ${timedOut ? `timed out after ${timeoutMs}ms` : e?.message}`);
}
