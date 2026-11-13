import { randomInt } from "node:crypto";

export interface UsernameRules {
  usernameMinLen: number;
  usernameMaxLen: number;
  usernamePattern: string; // charset, e.g. "a-z0-9._-"
}

export function validateUsername(username: string, rules: UsernameRules): boolean {
  let re: RegExp;
  try {
    re = new RegExp(`^[${rules.usernamePattern}]{${rules.usernameMinLen},${rules.usernameMaxLen}}$`);
  } catch {
    // Malformed usernamePattern — treat as invalid rather than throwing a 500.
    return false;
  }
  return re.test(username);
}

// No brand names: these end up in people's Lightning addresses. test/usernames.test.ts keeps every
// pairing, fallback suffix included, inside the default domain rules.
export const ADJECTIVES: readonly string[] = `
  swift calm bold lucky brave wise merry quiet sunny nimble
  sovereign stacking hodling orange laser diamond humble sound scarce honest trustless verified
  unspent confirmed timelocked multisig offchain onchain lightning atomic silent stealth genesis
  cold frosty zappy early patient private anon open free signed sealed batched virtual feeless
  dusty bullish immutable encrypted borderless vigilant frugal stoic steady ironclad golden lunar
  electric instant rebel punk retro vintage ancient legendary mythic epic pruned relayed routed
  settled spendable pristine hardened derived thrifty prudent diligent resolute unshaken tireless
  mighty fearless valiant noble loyal gentle jolly cheery happy chill cosmic astral galactic polar
  arctic icy fiery blazing radiant shiny glowing neon crimson violet indigo cobalt emerald copper
  silver velvet cozy comfy witty clever savvy sharp keen bright sage zen serene solid sturdy robust
  wild rogue classic heroic grand royal secret hidden mystic lucid vivid fuzzy fluffy plucky spry
  agile lively peppy snappy bouncy dapper groovy funky jazzy breezy misty stormy magnetic kinetic
  sonic turbo hyper rapid quick speedy zippy nocturnal dashing daring gallant smooth sleek crisp
  tidy wondrous curious gleaming sparkly starry sunlit moonlit brisk hearty trusty canny shrewd
`.trim().split(/\s+/);

export const NOUNS: readonly string[] = `
  otter finch cedar comet willow badger marlin sparrow lynx heron
  satoshi sats stacker hodler pleb miner node block nonce hash mempool utxo vtxo ark channel
  invoice preimage taproot segwit script opcode covenant locktime seed mnemonic xpub signer vault
  satchel stack wallet halving epoch chainwork bolt zap relay cypherpunk whale shrimp moon rocket
  stash coin blockspace faucet explorer oracle watchtower router peer gossip onion hop anchor
  outpoint witness sighash signet keychain hashrate difficulty timechain millisat bitcoiner builder
  citadel fortress beacon lantern compass key lock cipher glyph swap
  falcon eagle hawk owl raven fox wolf bear bison moose elk panda koala lemur gecko iguana turtle
  tortoise penguin puffin pelican orca dolphin narwhal octopus squid crab lobster hedgehog raccoon
  ferret marmot yak llama alpaca camel zebra tiger lion panther cheetah leopard coyote mongoose
  wombat platypus kiwi toucan parrot macaw robin wren lark starling magpie kestrel condor albatross
  stork crane ibis goose beetle mantis firefly dragonfly hornet squirrel chipmunk hamster acorn
  dragon griffin yeti unicorn wizard knight ninja viking monk nomad ranger scout pilot captain
  pioneer meteor nebula galaxy quasar pulsar nova orbit aurora glacier iceberg tundra canyon summit
  ridge harbor island volcano ember thunder pine maple birch aspen oak cactus lotus fern
`.trim().split(/\s+/);

/** Friendly adjective-noun handle, e.g. "stacking-satoshi". Always within the default charset/length. */
export function randomUsername(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}
