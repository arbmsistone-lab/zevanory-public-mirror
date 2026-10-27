// E4: full-page screenshots of the sales site at 360, 768 and 1440 px for visual comparison.
// Usage: [COLOR_SCHEME=dark] QUALITY_MODULES=/path/node_modules node sales-screenshots.mjs <baseUrl> <outDir>
// Files: <outDir>/<page>-<width>.png. Read-only, localhost only.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [base, outDir = "screenshots", modulesDir, browserPath, schemeArg] = process.argv.slice(2);
const req = createRequire(join(process.env.QUALITY_MODULES || modulesDir || join(process.cwd(), "node_modules"), "noop.js"));
const { chromium } = req("playwright");
const PAGES = (process.env.PAGES || "/solucoes,/zevanory-sales,/ia-na-pratica,/material-gratuito,/termos,/reembolso,/privacidade,/afiliados,/comprar/ZEV-IA-011").split(",");
const WIDTHS = [[320, 640], [360, 800], [390, 844], [768, 1024], [1440, 900]];
const SCHEME = (schemeArg || process.env.COLOR_SCHEME) === "dark" ? "dark" : "light";  // prefers-color-scheme emulation
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ ...(browserPath ? { executablePath: browserPath } : {}) });
for (const path of PAGES) for (const [width, height] of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce", colorScheme: SCHEME });
  const page = await ctx.newPage();
  await page.goto(base + path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // Lazy images (product previews) only load near the viewport: walk the page, then wait for them.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); }
    await Promise.all([...document.images].map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })));
    window.scrollTo(0, 0);
  });
  const file = join(outDir, `${path.replace(/^\//, "") || "index"}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  console.log("SCREENSHOT " + file);
  await ctx.close();
}
await browser.close();
