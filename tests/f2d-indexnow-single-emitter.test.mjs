// NC-G6-1026-02: o planejador do repositório é o ÚNICO emissor de IndexNow. Nenhum outro workflow, script ou
// módulo do Worker pode enviar (em lote ou não); com a âncora authorized:false, nada sai.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { withoutDirectIndexNow, isIndexNowEndpoint } from "../worker/indexnow-policy.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN = [".github/workflows", "scripts", "worker", "functions", "src"];
const EXT = /\.(ya?ml|m?js|cjs|ts|py|sh)$/;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) { if (n === "node_modules" || n.startsWith(".mutant") || n.includes(".mutant-")) continue; const p = join(dir, n); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (EXT.test(n)) out.push(p); }
  return out;
}
const files = SCAN.flatMap((d) => walk(join(ROOT, d))).map((p) => ({ rel: relative(ROOT, p).split("\\").join("/"), text: readTextNormalized(p) }));
// Endpoint de envio: api.indexnow.org, <motor>/indexnow ou qualquer host indexnow.*
const ENDPOINT = /https?:\/\/(?:api\.indexnow\.org|(?:www\.)?indexnow\.org|(?:www\.)?bing\.com\/indexnow|(?:www\.)?yandex\.[a-z.]+\/indexnow|search\.seznam\.cz\/indexnow|searchadvisor\.naver\.com\/indexnow|(?:indexnow\.)?yep\.com\/indexnow|[a-z0-9.-]*indexnow\.[a-z.]+)/i;
// Únicos lugares onde o endereço pode aparecer: o planejador (emissor), a política (bloqueio) e o módulo do blog cujo
// fetch passa SEMPRE por withoutDirectIndexNow.
const ALLOWED = new Set(["scripts/indexnow-publication.mjs", "worker/indexnow-policy.mjs", "worker/multichannel-autonomy.mjs"]);

test("nenhum emissor alternativo de IndexNow no repositório", () => {
  const offenders = files.filter((f) => ENDPOINT.test(f.text) && !ALLOWED.has(f.rel)).map((f) => f.rel);
  assert.deepEqual(offenders, [], "emissores fora do planejador: " + offenders.join(", "));
  assert.equal(existsSync(join(ROOT, ".github/workflows/indexnow-resubmit.yml")), false, "o reenvio legado em lote não pode voltar");
});

test("nenhum workflow além do indexnow-submit.yml chama o planejador ou expande sitemap para IndexNow", () => {
  const wf = files.filter((f) => f.rel.startsWith(".github/workflows/"));
  const callers = wf.filter((f) => /indexnow-publication\.mjs/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(callers, [".github/workflows/indexnow-submit.yml"]);
  // O indexnow-submit.yml usa os sitemaps só como GATILHO (paths); o planejador nunca os expande (teste acima).
  const fanout = wf.filter((f) => f.rel !== ".github/workflows/indexnow-submit.yml" && /sitemap\.xml/i.test(f.text) && /indexnow|urlList/i.test(f.text)).map((f) => f.rel);
  assert.deepEqual(fanout, [], "sitemap → IndexNow em lote: " + fanout.join(", "));
});

test("envio em lote não volta: o planejador manda exatamente 1 URL por POST e só ele monta urlList", async () => {
  const withList = files.filter((f) => /urlList/.test(f.text)).map((f) => f.rel).sort();
  for (const rel of withList) assert.ok(ALLOWED.has(rel), "urlList fora do planejador/política: " + rel);
  const src = files.find((f) => f.rel === "scripts/indexnow-publication.mjs").text;
  assert.match(src, /urlList:\[url\]/); assert.match(src, /if\(urls\.length!==1\|\|urls\[0\]!==url\)throw Error\('one_publication_only'\)/);
  const { submitPublication } = await import(new URL("../scripts/indexnow-publication.mjs", import.meta.url));
  const key = "ab".repeat(32); // chave SINTÉTICA de 64 hex (formato válido), montada em execução
  await assert.rejects(submitPublication({ url: "https://zevanory.api.br/a", key, urls: ["https://zevanory.api.br/a", "https://zevanory.api.br/b"] }, async () => new Response(null, { status: 200 })), /one_publication_only/);
});

test("barreira do Worker bloqueia TODOS os endpoints IndexNow, não só api.indexnow.org", async () => {
  let calls = 0; const f = withoutDirectIndexNow(async () => { calls++; return new Response("ok"); });
  for (const u of ["https://api.indexnow.org/indexnow", "https://www.bing.com/indexnow", "https://bing.com/indexnow?url=x&key=y", "https://yandex.com/indexnow", "https://search.seznam.cz/indexnow", "https://searchadvisor.naver.com/indexnow", "https://indexnow.yep.com/indexnow", "https://indexnow.org/indexnow"]) {
    assert.equal(isIndexNowEndpoint(u), true, u);
    const r = await f(u, { method: "POST" }); assert.equal(r.status, 409, u);
  }
  assert.equal(calls, 0);
  await f("https://www.bing.com/search?q=zevanory"); await f("https://zevanory.api.br/blog/x");
  assert.equal(calls, 2, "o resto da rede segue normal");
  const blog = files.find((f) => f.rel === "worker/multichannel-autonomy.mjs").text;
  assert.match(blog, /fetchImpl=withoutDirectIndexNow\(fetchImpl\);/);
});

test("âncora: só o workflow emissor único a consome; o lote continua proibido", () => {
  const anchor = JSON.parse(readTextNormalized(join(ROOT, "data/indexnow-continuity.json")));
  assert.equal(anchor.authorized, true);
  assert.deepEqual([anchor.rows, anchor.pending], [[], []]);
  const submit = files.find((f) => f.rel === ".github/workflows/indexnow-submit.yml").text;
  assert.match(submit, /indexnow-publication\.mjs/);
});
