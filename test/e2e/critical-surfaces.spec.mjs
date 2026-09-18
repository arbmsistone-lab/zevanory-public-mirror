import { test, expect } from "@playwright/test";

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
]) {
  test(`creative center is single-screen at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors=[];
    page.on("pageerror",e=>errors.push(String(e.message||e)));
    const response=await page.goto("/criativos",{waitUntil:"domcontentloaded"});
    expect(response?.status()).toBeLessThan(500);
    const activeFronts=page.locator(".production-item[data-front]");
    await expect(activeFronts).toHaveCount(9);
    for(const standby of ["tiktok","linkedin","nuvemshop"]) {
      await expect(page.locator(`.production-item[data-front="${standby}"]`)).toHaveCount(0);
    }
    const metrics=await page.evaluate(()=>({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.body.scrollHeight}));
    expect(metrics.sw).toBeLessThanOrEqual(metrics.w+2);
    expect(metrics.sh).toBeLessThanOrEqual(metrics.h+8);
    expect(errors).toEqual([]);
  });
}

test("creative channel selection exposes one active front", async ({ page }) => {
  await page.goto("/criativos",{waitUntil:"domcontentloaded"});
  const fronts=page.locator(".production-item[data-front]");
  await expect(fronts).toHaveCount(9);
  for(const standby of ["tiktok","linkedin","nuvemshop"]) {
    await expect(page.locator(`.production-item[data-front="${standby}"]`)).toHaveCount(0);
  }
  for(let i=0;i<9;i++){
    const button=fronts.nth(i);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed","true");
    await expect(page.locator('.production-item[aria-pressed="true"]')).toHaveCount(1);
  }
});

test("critical confirmation is fail-closed without an auditable reason", async ({ page }) => {
  await page.goto("/zevanory-robot-control",{waitUntil:"domcontentloaded"});
  await page.evaluate(()=>window.askCriticalConfirmation({title:'Teste crítico',summary:'Nenhuma ação externa deve ocorrer sem confirmação.',confirmLabel:'Confirmar',run:async()=>{}}));
  await expect(page.locator("#critical-dialog")).toBeVisible();
  await page.locator("#critical-confirm").click();
  await expect(page.locator("#critical-error")).toContainText("pelo menos 8 caracteres");
  await page.locator("#critical-reason").fill("motivo auditavel");
  await page.locator("#critical-confirm").click();
  await expect(page.locator("#critical-dialog")).not.toBeVisible();
});
