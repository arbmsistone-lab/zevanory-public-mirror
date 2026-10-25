// ZEVANORY | P03: pa11y (WCAG2AA, HTML_CodeSniffer) nas páginas de venda AO VIVO, uma vez por dia (B0).
// Somente leitura (Chrome headless faz GET). Grava um JSON por página com a contagem de erros; página que não
// pôde ser avaliada fica evaluated=false e o coletor grava NOT_AVAILABLE (fail-closed), nunca "0 erros".
// Uso: NODE_PATH=<prefixo>/node_modules node scripts/b0/p03-a11y.cjs <saida.json>
"use strict";
const fs = require("node:fs");
const pa11y = require("pa11y");
const PAGES = [
  "https://vendas.zevanory.api.br/",
  "https://vendas.zevanory.api.br/solucoes",
  "https://vendas.zevanory.api.br/ia-na-pratica",
  "https://vendas.zevanory.api.br/vendas-na-pratica",
  "https://vendas.zevanory.api.br/lucro-e-caixa",
  "https://vendas.zevanory.api.br/combo-ia-vendas",
  "https://vendas.zevanory.api.br/negocio-completo",
];
(async () => {
  const out = { schema: "zevanory.b0.p03-a11y.v1", at: new Date().toISOString(), tool: "pa11y@" + (process.env.PA11Y_VERSION || "9.0.1"), standard: "WCAG2AA", pages: [] };
  for (const url of PAGES) {
    try {
      const r = await pa11y(url, { standard: "WCAG2AA", timeout: 45000, wait: 1000, includeWarnings: false, includeNotices: false,
        chromeLaunchConfig: { args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] } });
      const errors = r.issues.filter((i) => i.type === "error");
      const codes = {};
      for (const e of errors) codes[e.code] = (codes[e.code] || 0) + 1;
      out.pages.push({ url, evaluated: true, errors: errors.length, codes });
    } catch (e) {
      out.pages.push({ url, evaluated: false, error: String((e && e.name) || "error").slice(0, 40) });
    }
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
  console.log("P03_A11Y " + JSON.stringify(out.pages.map((p) => [new URL(p.url).pathname, p.evaluated ? p.errors : "NOT_EVALUATED"])));
})();
