/** Where sealed checkpoints live. `S3Storage` is the production implementation. */
export interface EnclaveStorage {
  put(key: string, data: Uint8Array): Promise<void>;
  load(key: string): Promise<Uint8Array | undefined>;
}
