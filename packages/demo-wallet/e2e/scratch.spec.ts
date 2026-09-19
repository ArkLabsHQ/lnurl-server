import { test } from "@playwright/test";

// Drives scratch.html and prints what it saw. Not a gate — a debugging harness
// for the one thing that behaves differently in a browser than in Node.
test("scratch: why is solverLightningRail unavailable in the browser", async ({ page }) => {
  test.setTimeout(180_000);
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`));

  await page.goto("./scratch.html");
  await page.getByText("— done —").waitFor({ timeout: 150_000 });
  console.log("\n===== SCRATCH OUTPUT =====\n" + (await page.locator("#out").innerText()));
});
