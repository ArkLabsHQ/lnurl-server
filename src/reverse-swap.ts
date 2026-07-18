// Server-orchestrated reverse swaps for offline receive. The orchestration logic
// (callback fallback, settlement polling) depends only on the `ReverseSwapCreator`
// interface and is unit-tested with a fake; the real adapter is a thin shim over
// `@arkade-os/boltz-swap`'s walletless `createNonInteractiveReverseSwap`
// (arkade-os/ts-sdk#625), loaded lazily so typecheck/build don't require the
// package until it's published.

export interface ReverseSwapParams {
  /** Invoice amount in satoshis. */
  amountSat: number;
  /** Receiver's Arkade address — the covenant claim is constrained to pay it. */
  receiveAddress: string;
  /** Receiver's compressed claim public key (hex). */
  claimPublicKey: string;
}

export interface ReverseSwapResult {
  swapId: string;
  /** bolt11 hold invoice handed to the payer. */
  invoice: string;
  /** Preimage generated during swap creation. The server holds it privately and
   *  only reveals it via LUD-21 `verify` once the swap settles. */
  preimage: string;
  /** Payment hash — the LUD-21 verify key. */
  preimageHash: string;
  lockupAddress: string;
}

export interface ReverseSwapCreator {
  /** Create a non-interactive reverse swap paying `receiveAddress`. */
  create(params: ReverseSwapParams): Promise<ReverseSwapResult>;
  /** True once the swap's Lightning invoice has been paid (covclaimd will claim/has claimed). */
  isSettled(swapId: string): Promise<boolean>;
}

export interface OfflineReceiveSettings {
  boltzUrl: string;
  covclaimdUrl: string;
  arkNetwork: string;
}

/**
 * Real adapter over `@arkade-os/boltz-swap`. Pending publish of the walletless
 * helper (arkade-os/ts-sdk#625); the dynamic import uses a non-literal specifier
 * so typecheck/build don't require the package to be installed, and it is not
 * exercised by the test suite. This on-chain path is unverified in CI — it needs
 * a mutinynet Boltz + covclaimd to test end-to-end.
 */
export function createBoltzReverseSwapCreator(settings: OfflineReceiveSettings): ReverseSwapCreator {
  const pkgName = "@arkade-os/boltz-swap";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const load = async (): Promise<any> => import(pkgName);

  return {
    async create(params) {
      const mod = await load();
      const swapProvider = new mod.BoltzSwapProvider({ baseUrl: settings.boltzUrl, network: settings.arkNetwork });
      const covclaimd = new mod.CovclaimdProvider(settings.covclaimdUrl);
      const res = await mod.createNonInteractiveReverseSwap({
        swapProvider,
        covclaimd,
        amount: params.amountSat,
        claimPublicKey: params.claimPublicKey,
        claimAddress: params.receiveAddress,
      });
      return {
        swapId: res.id,
        invoice: res.invoice,
        preimage: res.preimage,
        preimageHash: res.preimageHash,
        lockupAddress: res.lockupAddress,
      };
    },
    async isSettled(swapId) {
      const mod = await load();
      const swapProvider = new mod.BoltzSwapProvider({ baseUrl: settings.boltzUrl, network: settings.arkNetwork });
      const status = await swapProvider.getSwapStatus(swapId);
      const s = typeof status === "string" ? status : status?.status;
      return mod.isReverseSuccessStatus ? Boolean(mod.isReverseSuccessStatus(s)) : false;
    },
  };
}
