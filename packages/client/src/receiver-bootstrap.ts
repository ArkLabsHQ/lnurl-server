import type { DomainCapabilities } from "./addresses.js";
import type { ArkadeLnurl, ClaimOptions, Receiver } from "./wallet.js";

export interface ReceiverBootstrapOptions {
  /** Discovery does not allocate a receiver unless explicitly enabled. */
  autoClaimNameless?: boolean;
  signal?: AbortSignal;
  refresh?: boolean;
}

export type ReceiverBootstrapResult =
  | {
      kind: "ready";
      receiver: Receiver;
      claimed: boolean;
      capabilities?: DomainCapabilities;
      capabilitiesError?: unknown;
    }
  | { kind: "onboarding"; capabilities: DomainCapabilities };

export async function bootstrapReceiver(
  facade: Pick<ArkadeLnurl, "owned" | "capabilities" | "claim">,
  opts: ReceiverBootstrapOptions = {},
): Promise<ReceiverBootstrapResult> {
  const { signal, refresh } = opts;
  const receiver = await facade.owned({ signal, refresh });
  if (receiver?.lightningAddress) return { kind: "ready", receiver, claimed: false };
  if (receiver) {
    try {
      return { kind: "ready", receiver, claimed: false, capabilities: await facade.capabilities() };
    } catch (capabilitiesError) {
      return { kind: "ready", receiver, claimed: false, capabilitiesError };
    }
  }

  const capabilities = await facade.capabilities();
  if (opts.autoClaimNameless && capabilities.allocationModes.includes("session") && !capabilities.requireApiKey) {
    return { kind: "ready", receiver: await facade.claim({ nameless: true }, { signal }), claimed: true, capabilities };
  }
  return { kind: "onboarding", capabilities };
}

export async function claimOrAdopt(
  facade: Pick<ArkadeLnurl, "owned" | "claim">,
  opts?: ClaimOptions,
): Promise<Receiver> {
  return (await facade.owned()) ?? facade.claim(opts);
}
