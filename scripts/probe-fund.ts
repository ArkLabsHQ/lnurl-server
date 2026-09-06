import { fundSolverFloat } from "../test/e2e/support/regtest.js";

async function main() {
  console.log("funding solver float...");
  await fundSolverFloat((s) => console.log(`[fund] ${s}`));
  console.log("done");
  process.exit(0);
}
void main();
