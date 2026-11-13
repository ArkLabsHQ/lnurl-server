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

// No Bitcoin or crypto product names: these end up in people's Lightning addresses.
// test/usernames.test.ts keeps every pairing, fallback suffix included, inside the default domain rules.
export const ADJECTIVES: readonly string[] = `
  swift calm bold lucky brave wise merry quiet sunny nimble
  sovereign stacking hodling orange laser diamond humble sound scarce honest trustless verified
  unspent confirmed timelocked multisig offchain onchain lightning atomic silent stealth genesis
  cold frosty zappy early patient private anon open free signed sealed batched virtual feeless
  dusty bullish immutable encrypted borderless vigilant frugal stoic steady ironclad golden lunar
  electric instant rebel punk retro vintage ancient legendary mythic epic pruned relayed routed
  settled spendable pristine hardened derived thrifty prudent diligent resolute unshaken tireless
  hodl rekt based toxic maxi degen wagmi ngmi gm ser wen fomo bearish pumped dumped mooning
  sideways parabolic liquidated leveraged rugged unhinged bigbrain smoothbrain orangepilled
  lasereyed paperhanded hyperbullish hard magic funny stacked zapped hashed mined tweaked blinded
  green feral witnessed uncensored unbanked nokyc selfhosted bitcoinonly unstoppable pseudonymous
  mighty fearless valiant noble loyal gentle jolly cheery happy chill cosmic astral galactic polar
  arctic icy fiery blazing radiant shiny glowing neon crimson violet indigo cobalt emerald copper
  silver velvet cozy comfy witty clever savvy sharp keen bright sage zen serene solid sturdy robust
  wild rogue classic heroic grand royal secret hidden mystic lucid vivid fuzzy fluffy plucky spry
  agile lively peppy snappy bouncy dapper groovy funky jazzy breezy misty stormy magnetic kinetic
  sonic turbo hyper rapid quick speedy zippy nocturnal dashing daring gallant smooth sleek crisp
  tidy wondrous curious gleaming sparkly starry sunlit moonlit brisk hearty trusty canny shrewd
  spicy salty crunchy toasty frothy bubbly fizzy zesty tangy sweet savory smoky minty nutty cheesy
  saucy juicy chunky chonky thicc smol tiny giant mega ultra super giga nano micro macro cyber
  digital analog glitchy wired wireless nuclear radioactive volcanic tectonic seismic tidal solar
  orbital martian alien ghostly spooky creepy haunted cursed blessed holy sacred divine rare
  ultrarare platinum titanium chrome pastel matte glossy glittery dazzling hypnotic psychedelic
  trippy emo goth preppy nerdy geeky dorky quirky wacky zany goofy silly cheeky sassy spunky feisty
  scrappy gritty hungry thirsty sleepy dreamy hazy foggy rainy snowy windy cloudy tropical majestic
  regal imperial ultimate supreme prime alpha omega sigma beta gamma lambda binary quantum infinite
  eternal timeless stealthy sneaky shadowy
`.trim().split(/\s+/);

export const NOUNS: readonly string[] = `
  otter finch cedar comet willow badger marlin sparrow lynx heron
  satoshi sats stacker hodler pleb miner node block nonce hash mempool utxo vtxo ark channel
  invoice preimage taproot segwit script opcode covenant locktime seed mnemonic xpub signer vault
  satchel stack wallet halving epoch chainwork bolt zap relay cypherpunk whale shrimp moon rocket
  stash coin blockspace faucet explorer oracle watchtower router peer gossip onion hop anchor
  outpoint witness sighash signet keychain hashrate difficulty timechain millisat bitcoiner builder
  citadel fortress beacon lantern compass key lock cipher glyph swap
  lambo bull nocoiner precoiner normie fren chad gigachad wojak pepe ape goblin boomer zoomer
  moonboy goldbug tendies hopium copium stonks bags bagholder printer brrr fiat money pizza
  chancellor bailout brink halvening blocksize uasf softfork hardfork jpeg ordinal rune lasereyes
  orangepill rabbithole ticktock nextblock honeybadger fud rugpull dip ath nostrich ostrich cabal
  glowie fed maximalist stackchain diamondhands paperhands altcoin ponzi tulip bubble nakamoto
  candle godcandle wick chart pump dump bullrun supercycle capitulation squeeze shortsqueeze
  fakeout breakout rally shill supercoder troll
  falcon eagle hawk owl raven fox wolf bear bison moose elk panda koala lemur gecko iguana turtle
  tortoise penguin puffin pelican orca dolphin narwhal octopus squid crab lobster hedgehog raccoon
  ferret marmot yak llama alpaca camel zebra tiger lion panther cheetah leopard coyote mongoose
  wombat platypus kiwi toucan parrot macaw robin wren lark starling magpie kestrel condor albatross
  stork crane ibis goose beetle mantis firefly dragonfly hornet squirrel chipmunk hamster acorn
  beaver cougar axolotl capybara quokka okapi tapir manatee seal wolverine ocelot caracal hyena
  dingo fennec meerkat armadillo sloth anteater aardvark porcupine skunk chinchilla rabbit hare
  kangaroo wallaby emu flamingo peacock osprey vulture kingfisher hummingbird woodpecker shark
  stingray barracuda swordfish seahorse starfish jellyfish oyster nautilus krill beluga ladybug
  bumblebee butterfly scorpion tarantula cobra viper mamba chameleon salamander frog toad
  dragon griffin yeti unicorn wizard knight ninja viking monk nomad ranger scout pilot captain
  pioneer leviathan behemoth titan cyclops minotaur centaur sphinx gnome ogre pixie genie valkyrie
  druid shaman warlock sorcerer alchemist paladin bard jester hermit pirate buccaneer corsair
  outlaw bandit gunslinger cowboy sheriff shogun sensei guru yogi
  meteor nebula galaxy quasar pulsar nova orbit aurora asteroid supernova rover satellite
  astronaut cosmonaut starship moonbase eclipse zenith horizon equinox solstice photon neutron
  proton quark atom prism crystal quartz obsidian granite sapphire topaz opal onyx garnet pearl ruby
  glacier iceberg tundra canyon summit ridge harbor island volcano ember thunder blaze cyclone
  typhoon hurricane blizzard tsunami monsoon tempest sunrise sunset twilight meadow prairie
  savanna jungle grove orchard valley mesa fjord lagoon oasis geyser crater cavern grotto boulder
  pebble pine maple birch aspen oak cactus lotus fern sequoia redwood cypress juniper spruce bamboo
  coconut pumpkin peanut walnut chestnut almond pretzel waffle muffin cookie cupcake donut bagel
  taco burrito nacho noodle dumpling ramen pickle biscuit burger popcorn espresso latte mocha
  honey caramel toffee fudge pudding marshmallow
  anvil hammer forge kite yoyo jukebox boombox cassette vinyl synth banjo ukulele trumpet bongo
  kazoo gong piano violin cello flute blimp glider jetpack hovercraft submarine canoe kayak
  schooner galleon tugboat tractor bulldozer unicycle skateboard scooter caboose batch
`.trim().split(/\s+/);

/** Friendly adjective-noun handle, e.g. "stacking-satoshi". Always within the default charset/length. */
export function randomUsername(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}
