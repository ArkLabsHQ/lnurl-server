import { Ramps, type Wallet } from "@arkade-os/sdk";

export type BoardingState =
  | { status: "idle" }
  | { status: "boarding"; sats: number }
  | { status: "boarded"; sats: number; txid: string }
  | { status: "failed"; reason: string };

/**
 * Onboards confirmed boarding funds into VTXOs.
 *
 * Only `confirmed`: an unconfirmed deposit has no boarding input to spend yet,
 * so attempting it fails rather than waiting. `Ramps.onboard` deducts its fee
 * from the amount it is handed and settles every boarding input when given no
 * explicit list, which is what "settle whatever arrived" means here.
 */
export async function settleBoarding(wallet: Wallet): Promise<BoardingState> {
  const balance = await wallet.getBalance();
  const sats = balance.boarding.confirmed;
  if (sats <= 0) return { status: "idle" };
  try {
    const txid = await new Ramps(wallet).onboard(await wallet.arkProvider.getInfo().then((i) => i.fees));
    return { status: "boarded", sats, txid };
  } catch (err) {
    return { status: "failed", reason: (err as Error).message };
  }
}

/**
 * Polls for confirmed boarding funds and settles them as they appear.
 *
 * Serialised behind `running`: settlement is slow and the poll is not, so
 * without it a second pass would try to spend inputs the first is already
 * settling. Returns an unsubscribe.
 */
export function autoSettleBoarding(
  wallet: Wallet,
  onChange: (state: BoardingState) => void,
  intervalMs = 15_000,
): () => void {
  let live = true;
  let running = false;

  const tick = async () => {
    if (!live || running) return;
    running = true;
    try {
      const balance = await wallet.getBalance();
      if (balance.boarding.confirmed > 0) {
        onChange({ status: "boarding", sats: balance.boarding.confirmed });
        const result = await settleBoarding(wallet);
        if (live) onChange(result);
      }
    } catch {
      // A failed poll is not a failed onboard: stay quiet and try again.
    } finally {
      running = false;
    }
  };

  void tick();
  const id = setInterval(() => void tick(), intervalMs);
  return () => { live = false; clearInterval(id); };
}
