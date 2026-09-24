export type Choice = "self" | "random" | "nameless" | "claimCode";

/** Which ways to get an address a domain's `allocationModes` allow. `admin` is
 *  the operator reserving names, which a wallet can only take with a claim code. */
export function nameChoices(modes: readonly string[], opts: { nameless: boolean }): Record<Choice, boolean> {
  return {
    self: modes.includes("self"),
    random: modes.includes("random"),
    nameless: opts.nameless && modes.includes("session"),
    claimCode: modes.includes("admin"),
  };
}

/** The argument each choice passes, as it would read in code. */
export const CHOICE_ARGS: Record<Choice, string> = {
  self: "{ username }",
  random: "",
  nameless: "{ nameless: true }",
  claimCode: "{ username, claimCode }",
};
