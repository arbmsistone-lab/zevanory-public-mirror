// ZEVANORY | P18 verificação comercial: renderizador opcional por navegador (checkouts SPA cujo HTML estático não
// mostra produto nem produtor). Usado só no modo live do workflow agendado (--browser); os testes nunca o importam.
//
// Somente leitura, por construção:
//  - contexto novo e vazio a cada link (sem storageState, sem cookies próprios; clearCookies antes da navegação);
//  - TODA requisição que não seja GET é abortada (page.route) e contada em blocked_non_get: nenhum POST, PUT,
//    PATCH ou DELETE sai do navegador, então nenhuma transação, carrinho ou lead pode ser criado;
//  - navegação só para hosts da lista (redirect_hosts); sair dela = erro;
//  - nunca clica, nunca preenche formulário.
import { chromium } from "playwright";
import { USER_AGENT } from "./p18-commercial.mjs";

export function makeBrowserRenderer(allow, { timeoutMs = 45_000 } = {}) {
  let browser = null;
  const render = async (url) => {
    browser ||= await chromium.launch();
    const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "pt-BR", javaScriptEnabled: true, acceptDownloads: false });
    await ctx.clearCookies();
    let blocked = 0;
    await ctx.route("**/*", (route) => {
      if (route.request().method() !== "GET") { blocked++; return route.abort("blockedbyclient"); }
      return route.continue();
    });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => null);
      await page.waitForTimeout(3000);
      const final = new URL(page.url());
      if (!allow.redirect_hosts.includes(final.hostname)) return { status: 0, error: "redirect_host_not_allowed:" + final.hostname, body: "", blocked_non_get: blocked };
      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || "");
      return { status: resp ? resp.status() : 0, body: html + "\n" + text, hops: [{ url, status: resp ? resp.status() : 0 }], blocked_non_get: blocked };
    } finally { await ctx.close(); }
  };
  render.close = async () => { await browser?.close(); browser = null; };
  return render;
}
