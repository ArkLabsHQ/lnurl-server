import type { EncryptedToken } from "../crypto.js";

export type AllocationMode = "self" | "random" | "admin";
export type AddressStatus = "reserved" | "active" | "revoked";

export interface DomainRow {
  id: number;
  domain: string;
  allocationModes: AllocationMode[];
  requireApiKey: boolean;
  maxPerSession: number | null;
  usernameMinLen: number;
  usernameMaxLen: number;
  usernamePattern: string;
  minSendable: number | null;
  maxSendable: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateDomainParams {
  domain: string;
  allocationModes: AllocationMode[];
  requireApiKey?: boolean;
  maxPerSession?: number | null;
  usernameMinLen?: number;
  usernameMaxLen?: number;
  usernamePattern?: string;
  minSendable?: number | null;
  maxSendable?: number | null;
  enabled?: boolean;
}

export interface AddressRow {
  id: number;
  domainId: number;
  username: string;
  sessionId: string | null;
  encryptedToken: EncryptedToken | null;
  claimCodeHash: Buffer | null;
  status: AddressStatus;
  metadata: string | null;
  /** Arkade address to receive offline swaps to; null if offline receive isn't configured. */
  arkadeAddress: string | null;
  /** Compressed claim public key (hex) for offline reverse swaps; null if unset. */
  claimPublicKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAddressParams {
  domainId: number;
  username: string;
  status: AddressStatus;
  sessionId?: string | null;
  encryptedToken?: EncryptedToken | null;
  claimCodeHash?: Buffer | null;
  metadata?: string | null;
}

export interface BlacklistRow {
  id: number;
  domainId: number | null;
  username: string;
  reason: string | null;
  createdAt: number;
}
