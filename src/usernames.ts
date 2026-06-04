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

const ADJECTIVES = ["swift", "calm", "bold", "lucky", "brave", "wise", "merry", "quiet", "sunny", "nimble"];
const NOUNS = ["otter", "finch", "cedar", "comet", "willow", "badger", "marlin", "sparrow", "lynx", "heron"];

/** Friendly adjective-noun handle, e.g. "swift-otter". Always within the default charset/length. */
export function randomUsername(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}

export function isValidToken(token: string): boolean {
  return /^[0-9a-f]+$/i.test(token) && token.length >= 32;
}
