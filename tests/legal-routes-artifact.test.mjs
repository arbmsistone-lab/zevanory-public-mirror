// Rodada 5 (reauditoria do PR #946): as rotas jurídicas do Worker de vendas REAL servem o corpo byte a byte igual ao
// arquivo do artefato (sales-public/<rota>.html) que o portão jurídico confere: com o chat ligado, com vendas abertas,
// com parâmetros UTM, com Accept-Encoding gzip, com e sem barra final. Nenhuma injeção em tempo de execução.
// Rótulos [LRn.k].
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import salesWorker, { LEGAL_ROUTES, SITE_CHAT_PAGES } from "../worker/sales-public-worker.mjs";
import { spawnSync } from "node:child_process";
import { requireTool } from "./helpers/toolchain.mjs";

const PY = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
requireTool(PY);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ART = join(ROOT, "sales-public");
const ORIGIN = "https://vendas.zevanory.api.br";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
// ASSETS do Workers: devolve os bytes do arquivo do artefato, como o binding de assets.
const assets = { async fetch(req) {
  const p = decodeURIComponent(new URL(req.url).pathname);
  try { const body = readFileSync(join(ART, p)); return new Response(body, { status: 200, headers: { "content-type": p.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } }); }
  catch { return new Response("not found", { status: 404 }); }
} };
// CORE: vendas ABERTAS e o resto respondendo, para provar que nada do modo aberto toca as páginas jurídicas.
const core = { async fetch(input) { const url = String(input?.url || input); if (url.endsWith("/api/sales/status")) return Response.json({ open: true }); if (url.includes("reviews")) return Response.json({}); return new Response(null, { status: 204 }); } };
const ENV = { CORE: core, ASSETS: assets, SITE_CHAT_ENABLED: "true", SALE_GLOBALLY_ENABLED: "true" };
const ctx = { waitUntil() {}, passThroughOnException() {} };

test("LR1 as quatro rotas jurídicas são exatamente as páginas que o portão confere, e nenhuma recebe o chat", async () => {
  assert.deepEqual([...LEGAL_ROUTES].sort(), ["afiliados", "privacidade", "reembolso", "termos"], "[LR1.1]");
  for (const r of LEGAL_ROUTES) assert.ok(!SITE_CHAT_PAGES.has(r), `[LR1.2] ${r}`);
  const out = spawnSync(PY, ["-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import legal_review as l; print(','.join(sorted(l.SERVED_LEGAL)))", join(ROOT, "scripts/p23")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(out.stdout.trim(), "afiliados,privacidade,reembolso,termos", "[LR1.3] o portão confere as mesmas rotas " + out.stderr);
});

test("LR2 o corpo servido é byte a byte o arquivo do artefato, em todas as variantes de pedido", async () => {
  for (const route of LEGAL_ROUTES) {
    const want = readFileSync(join(ART, route + ".html"));
    for (const [label, path, headers] of [
      ["simples", `/${route}`, {}],
      ["barra final", `/${route}/`, {}],
      ["UTM", `/${route}?utm_source=x&utm_medium=y&utm_campaign=z`, {}],
      ["gzip", `/${route}`, { "accept-encoding": "gzip, br" }],
    ]) {
      const res = await salesWorker.fetch(new Request(ORIGIN + path, { headers: { "user-agent": CHROME, ...headers } }), ENV, ctx);
      assert.equal(res.status, 200, `[LR2.1] ${route} ${label}`);
      assert.equal(res.headers.get("content-encoding"), null, `[LR2.2] ${route} ${label}: corpo sem recodificação`);
      const got = Buffer.from(await res.arrayBuffer());
      assert.ok(got.equals(want), `[LR2.3] ${route} ${label}: corpo difere do artefato (${got.length} x ${want.length} bytes)`);
    }
  }
});

test("LR3 HEAD de rota jurídica não tem corpo e mantém os cabeçalhos de segurança", async () => {
  const res = await salesWorker.fetch(new Request(ORIGIN + "/termos", { method: "HEAD", headers: { "user-agent": CHROME } }), ENV, ctx);
  assert.equal(res.status, 200, "[LR3.1]");
  assert.equal((await res.arrayBuffer()).byteLength, 0, "[LR3.2]");
  assert.ok(res.headers.get("content-security-policy") || res.headers.get("x-content-type-options"), "[LR3.3] cabeçalhos de segurança aplicados");
});
