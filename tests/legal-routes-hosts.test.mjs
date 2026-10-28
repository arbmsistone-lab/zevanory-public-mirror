// Rodada 12 (MED-1): as rotas jurídicas só têm conteúdo em vendas.zevanory.api.br (portão por bytes + snapshot
// aprovado). Em todo outro host da ZEVANORY — apex (roteador público) e edge./backup./workers.dev (Worker central) —
// /termos, /privacidade, /reembolso e /afiliados (com .html, barra final, maiúsculas, query) respondem 308 para a
// mesma rota em vendas, sem corpo próprio. Roda o roteador e o ponto de entrada REAL do central. Rótulos [LH].
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import router from "../worker/public-surface-router.mjs";
import { legalRouteRedirect, LEGAL_ROUTE_NAMES } from "../worker/legal-routes-redirect.mjs";
import { LEGAL_ROUTES } from "../worker/sales-public-worker.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VARIANTS = (r) => [[`/${r}`, ""], [`/${r}/`, ""], [`/${r}.html`, ""], [`/${r}/index.html`, ""], [`/${r.toUpperCase()}`, ""], [`/${r}?utm_source=x`, "?utm_source=x"]];

test("LH1 o módulo âncora cobre exatamente as rotas jurídicas do Worker de vendas e nada mais", () => {
  assert.deepEqual([...LEGAL_ROUTE_NAMES].sort(), [...LEGAL_ROUTES].sort(), "[LH1.1]");
  for (const p of ["/", "/solucoes", "/termos-de-uso-x", "/api/termos", "/reembolsos"]) assert.equal(legalRouteRedirect(new Request("https://edge.zevanory.api.br" + p)), null, `[LH1.2] ${p}`);
});

test("LH2 apex (roteador público): toda variante de rota jurídica vai para vendas, sem corpo", async () => {
  for (const r of LEGAL_ROUTES) for (const [path, q] of VARIANTS(r)) {
    const res = await router.fetch(new Request("https://zevanory.api.br" + path));
    assert.equal(res.status, 308, `[LH2.1] ${path}`);
    assert.equal(res.headers.get("location"), `https://vendas.zevanory.api.br/${r}${q}`, `[LH2.2] ${path}`);
    assert.equal((await res.text()).length, 0, `[LH2.3] ${path}`);
  }
});

test("LH3 Worker central (ponto de entrada real) em edge., backup. e workers.dev: 308 para vendas antes de tocar o ambiente", () => {
  const urls = [];
  for (const host of ["edge.zevanory.api.br", "backup.zevanory.api.br", "zevanory.arbmsist.workers.dev", "zevanory.api.br"])
    for (const r of LEGAL_ROUTES) for (const [path] of VARIANTS(r)) urls.push(`https://${host}${path}`);
  const p = spawnSync(process.execPath, [join(ROOT, "tests/helpers/central-entry-probe.mjs"), join(ROOT, "worker/cloudflare-worker.compat.mjs"), ...urls], { encoding: "utf8", timeout: 120000 });
  assert.equal(p.status, 0, "[LH3.0] " + p.stderr);
  const out = JSON.parse(p.stdout);
  assert.equal(out.length, urls.length, "[LH3.1]");
  for (const o of out) {
    const u = new URL(o.url), name = u.pathname.split("/")[1].replace(/\.html$/, "").toLowerCase();
    assert.equal(o.status, 308, `[LH3.2] ${o.url}: ${o.error || o.status}`);
    assert.equal(o.location, `https://vendas.zevanory.api.br/${name}${u.search}`, `[LH3.3] ${o.url}`);
    assert.equal(o.body, 0, `[LH3.4] ${o.url}`);
  }
});
