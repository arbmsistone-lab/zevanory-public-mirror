import { test, expect } from "@playwright/test";

test("single-screen public surface remains stable", async ({
  page,
}, testInfo) => {
  const pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push(String(error.message || error)),
  );
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(response).not.toBeNull();
  expect(response.status()).toBeLessThan(500);
  await expect(page.locator("body")).toBeVisible();
  expect((await page.title()).trim().length).toBeGreaterThan(0);
  const metrics = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    htmlWidth: document.documentElement.scrollWidth,
    bodyHeight: document.body.scrollHeight,
  }));
  expect(metrics.htmlWidth).toBeLessThanOrEqual(metrics.width + 2);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.height + 8);
  expect(pageErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("zevanory-home.png"),
    fullPage: true,
  });
});
