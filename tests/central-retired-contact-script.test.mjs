// ZEVANORY | Apex (zevanory.api.br, central Worker): the retired contact script.
// The frozen 83620c6 snapshot loads /whatsapp-contact.js on 19 pages. Its oldest copies injected wa.me
// links to the banned number and browsers cached them for a long time. Contract:
//   (a) the central Worker answers the old path with an inert, no-store tombstone that also carries
//       Clear-Site-Data: "cache" (the same decision as the sales Worker, PR #911); exact path only,
//       before any env/KV access, and every other route is untouched;
//   (b) the generator (scripts/deploy/prepare-central-candidate.py) no longer publishes the file, strips
//       every reference from the pages, keeps the e-mail rewrite the script used to do (build time, only
//       on those pages), and fails closed if anything published still names the script.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";
import { requireTool } from "./helpers/toolchain.mjs";
import { retiredPublicAssetResponse, RETIRED_CONTACT_SCRIPT, RETIRED_CONTACT_BODY, RETIRED_CONTACT_CLEAR_SITE_DATA, RETIRED_PAGE_REDIRECTS } from "../worker/retired-public-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(ROOT, "scripts/deploy/prepare-central-candidate.py");
const PYTHON = process.platform === "win32" ? "python" : "python3";
const NAME = ["whatsapp", "contact"].join("-");
const req = (path, method = "GET") => new Request("https://zevanory.api.br" + path, { method });

test("(a) tombstone: GET/HEAD 200, inert body, no-store, Clear-Site-Data cache, nosniff", async () => {
  assert.equal(RETIRED_CONTACT_SCRIPT, `/${NAME}.js`);
  for (const [path, method] of [[RETIRED_CONTACT_SCRIPT, "GET"], [RETIRED_CONTACT_SCRIPT + "?v=3", "GET"], [RETIRED_CONTACT_SCRIPT, "HEAD"]]) {
    const res = retiredPublicAssetResponse(req(path, method));
    assert.ok(res, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("clear-site-data"), '"cache"', path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-type"), /^text\/javascript/);
    assert.equal(await res.text(), method === "HEAD" ? "" : RETIRED_CONTACT_BODY);
  }
  assert.equal(RETIRED_CONTACT_CLEAR_SITE_DATA, '"cache"', "cache only: never cookies, storage or executionContexts");
  assert.doesNotMatch(RETIRED_CONTACT_BODY, /wa\.me|whatsapp|\d{8,}|document|location|fetch|import|mailto/i, "no behaviour at all");
  const post = retiredPublicAssetResponse(req(RETIRED_CONTACT_SCRIPT, "POST"));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(post.headers.get("cache-control"), "no-store");
});

test("(a) tombstone: exact path only, every other route passes through", () => {
  for (const path of ["/", "/solucoes", "/termos", "/api/health", `/${NAME}.jsx`, `/${NAME}.js/`, `/${NAME.toUpperCase()}.JS`, `/x/${NAME}.js`, `/${NAME}.js.map`, `/${NAME}`, "/site-chat.js", "/brand/export/x"]) {
    assert.equal(retiredPublicAssetResponse(req(path)), null, path);
  }
  assert.equal(retiredPublicAssetResponse({ url: "not a url", method: "GET" }), null);
});

test("(a) central Worker: the tombstone is the first thing processFetch does (before env/KV), nowhere else", () => {
  const src = readTextNormalized(join(ROOT, "worker/cloudflare-worker.compat.mjs"));
  assert.match(src, /^import \{ retiredPublicAssetResponse \} from "\.\/retired-public-assets\.mjs";$/m);
  const body = src.slice(src.indexOf("async processFetch(request, env, ctx) {"));
  const firstStatements = body.split("\n").slice(1).filter((l) => l.trim() && !l.trim().startsWith("//")).slice(0, 3).map((l) => l.trim());
  assert.deepEqual(firstStatements.slice(0, 2), ["const retiredAsset = retiredPublicAssetResponse(request);", "if (retiredAsset) return retiredAsset;"]);
  assert.equal((src.match(/retiredPublicAssetResponse\(/g) || []).length, 1, "single call site");
  assert.doesNotMatch(src, /clear-site-data/i, "Clear-Site-Data only on the tombstone module");
});

const HEALTH_ANCHOR = "const commercialSafetyLocked = publicSafetyLocked || pilotSafetyLocked || preSaleCutoverSafe || commercialLivePattern;";
const TAG = `<script src="/${NAME}.js" defer></script>`;
function runGenerator(publicFiles) {
  const dir = mkdtempSync(join(tmpdir(), "zev-retired-contact-"));
  try {
    mkdirSync(join(dir, "worker")); mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "wrangler.central-fix.jsonc"), JSON.stringify({ name: "zevanory", vars: {}, triggers: { crons: ["0 * * * *"] } }, null, 2));
    writeFileSync(join(dir, "worker/binding-aliases.mjs"), "      return Reflect.get(target, prop, receiver);\n      return Reflect.has(target, prop);\n");
    writeFileSync(join(dir, "worker/cloudflare-worker.recovered.mjs"), HEALTH_ANCHOR + "\n");
    const files = { "solucoes.html": "<main>solucoes</main>\n", "sitemap.xml": "<urlset></urlset>\n", ...publicFiles };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "public", name), text);
    requireTool(PYTHON);
    const r = spawnSync(PYTHON, ["-B", GENERATOR], {
      cwd: dir, encoding: "utf8", timeout: 60000, windowsHide: true,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PUBLIC_OWNER_ACCOUNT_ID: "0".repeat(32), TARGET_RUNTIME_SHA: "a".repeat(40), ZEVANORY_LAUNCH_AUTHORIZATION: "" },
    });
    const out = Object.fromEntries(Object.keys(files).map((n) => [n, existsSync(join(dir, "public", n)) ? readFileSync(join(dir, "public", n), "utf8") : null]));
    return { status: r.status, output: String(r.stdout || "") + String(r.stderr || ""), read: (n) => out[n] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The e-mail rewrite used to be pinned to the pages that loaded the script (d.html stayed with contato@ on purpose:
// the frozen /exclusao-dados page never loaded it and kept "contato@" twice, a PR #935 follow-up waiting for an owner
// decision). Decision delegated 2026-10-25: the apex publishes ONLY the official mailbox of data/politica-unica.json
// (suporte@; contato@ is still accepted as an inbound alias by worker/support-email-forward.mjs). So d.html is now
// rewritten too, and pages that loaded the script keep the stricter rewrite (subject dropped, same href the script made).
test("(b) generator: no published copy, every reference stripped, official mailbox on every page", () => {
  const r = runGenerator({
    [`${NAME}.js`]: "(()=>{const EMAIL='suporte@zevanory.api.br';})();\n",
    "a.html": `<a class="nav-cta" href="mailto:contato@zevanory.api.br?subject=Quero%20avaliar">Falar</a>${TAG}</body>\n`,
    "b.html": `<footer>x</footer>\n  ${TAG}\n</body>\n`,
    "c.html": `<script src="/${NAME}.js"></script><script defer src="/${NAME}.js" ></script><p>ok</p>\n`,
    "d.html": '<p><a href="mailto:contato@zevanory.api.br">contato@zevanory.api.br</a></p>\n',
  });
  assert.equal(r.status, 0, r.output.slice(-800));
  assert.match(r.output, /^PUBLIC_RETIRED_CONTACT_SCRIPT=ABSENT$/m);
  assert.equal(r.read(`${NAME}.js`), null, "file no longer generated");
  assert.equal(r.read("a.html"), '<a class="nav-cta" href="mailto:suporte@zevanory.api.br">Falar</a></body>\n', "same href the e-mail-only script produced");
  assert.equal(r.read("b.html"), "<footer>x</footer>\n</body>\n");
  assert.equal(r.read("c.html"), "<p>ok</p>\n");
  assert.equal(r.read("d.html"), '<p><a href="mailto:suporte@zevanory.api.br">suporte@zevanory.api.br</a></p>\n', "a page that never loaded the script now shows the official mailbox too");
});

test("(b) generator fails closed on any other mention of the retired script in published assets", () => {
  for (const [name, text] of [
    ["p.html", `<link rel="preload" href="/${NAME}.js" as="script">\n`],
    ["loader.js", `import("/${NAME}.js");\n`],
    ["q.html", `<script type="module" src='/${NAME}.js'></script>\n`],
  ]) {
    const r = runGenerator({ [name]: text });
    assert.notEqual(r.status, 0, name);
    assert.match(r.output, new RegExp(`PUBLIC_RETIRED_CONTACT_SCRIPT_REFERENCED .*${name.replace(".", "\\.")}`), name);
  }
});

// Retired legacy pages of the frozen snapshot (decision delegated 2026-10-25, PR #935 follow-up):
// /piloto and /piloto-interesse -> store catalogue, /confianca -> canonical "Quem criou"; 308 + noindex, no body.
test("(c) retired pages: 308 to the canonical store page, noindex, query dropped, exact paths only", async () => {
  assert.deepEqual(RETIRED_PAGE_REDIRECTS, {
    "/piloto": "https://vendas.zevanory.api.br/solucoes",
    "/piloto-interesse": "https://vendas.zevanory.api.br/solucoes",
    "/confianca": "https://vendas.zevanory.api.br/quem-criou/",
  });
  // Each target is the canonical the store itself declares (single source of truth: sales-public).
  for (const [slug, target] of [["solucoes", RETIRED_PAGE_REDIRECTS["/piloto"]], ["quem-criou", RETIRED_PAGE_REDIRECTS["/confianca"]]]) {
    assert.ok(readTextNormalized(join(ROOT, "sales-public", slug + ".html")).includes(`<link rel="canonical" href="${target}">`), slug);
  }
  for (const [base, target] of Object.entries(RETIRED_PAGE_REDIRECTS)) {
    for (const path of [base, base + "/", base + ".html", base + "?utm_source=x&ref=y"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = retiredPublicAssetResponse(req(path, method));
        assert.ok(res, path);
        assert.equal(res.status, 308, path);
        assert.equal(res.headers.get("location"), target, path);
        assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
        assert.equal(res.headers.get("clear-site-data"), null, "Clear-Site-Data only on the script tombstone");
        assert.equal(await res.text(), "", path);
      }
    }
    const post = retiredPublicAssetResponse(req(base, "POST"));
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
    assert.equal(post.headers.get("location"), null);
  }
  for (const path of ["/pilotos", "/piloto/x", "/PILOTO", "/piloto.js", "/piloto.css", "/piloto-interesse.js", "/confiancas", "/confianca/x",
    "/x/confianca", "/exclusao-dados", "/quem-criou", "/blog", "/sitemap.xml"]) {
    assert.equal(retiredPublicAssetResponse(req(path)), null, path);
  }
});

test("(c) generator: retired page files and their own assets are no longer published", () => {
  const r = runGenerator({
    "piloto.html": "<h1>Piloto</h1>\n", "piloto.css": "a{}\n", "piloto.js": "1;\n",
    "piloto-interesse.html": "<h1>Interesse</h1>\n", "piloto-interesse.js": "2;\n",
    "confianca.html": "<h1>Confiança</h1>\n", "termos.html": "<p>termos</p>\n",
  });
  assert.equal(r.status, 0, r.output.slice(-800));
  assert.match(r.output, /^PUBLIC_RETIRED_PAGES=ABSENT$/m);
  for (const n of ["piloto.html", "piloto.css", "piloto.js", "piloto-interesse.html", "piloto-interesse.js", "confianca.html"]) assert.equal(r.read(n), null, n);
  assert.equal(r.read("termos.html"), "<p>termos</p>\n", "other pages untouched");
});

test("(c) generator: /exclusao-dados, JSON-LD and security.txt publish only the official mailbox of the single policy", () => {
  const policy = JSON.parse(readFileSync(join(ROOT, "data/politica-unica.json"), "utf8"));
  assert.equal(policy.contato_publico.email, "suporte@zevanory.api.br");
  const exclusao = '<h2>Como solicitar</h2><p>Envie a solicitação para <strong>contato@zevanory.api.br</strong> com o assunto <strong>Exclusão de dados</strong>.</p>\n<p class="muted">Canal oficial: contato@zevanory.api.br</p>\n';
  const r = runGenerator({ "exclusao-dados.html": exclusao, "index.html": '{"@type":"Organization","email":"contato@zevanory.api.br"}\n', "security.txt": "Contact: mailto:contato@zevanory.api.br\n" });
  assert.equal(r.status, 0, r.output.slice(-800));
  assert.match(r.output, /^PUBLIC_OFFICIAL_MAILBOX_ONLY=PASS$/m);
  assert.equal(r.read("exclusao-dados.html"), exclusao.replaceAll("contato@", "suporte@"));
  assert.equal((r.read("exclusao-dados.html").match(/suporte@zevanory\.api\.br/g) || []).length, 2);
  assert.equal(r.read("index.html"), '{"@type":"Organization","email":"suporte@zevanory.api.br"}\n');
  assert.equal(r.read("security.txt"), "Contact: mailto:suporte@zevanory.api.br\n");
});

test("(c) generator fails closed when the legacy mailbox survives in a published asset the rewrite does not cover", () => {
  const r = runGenerator({ "font.woff2": "contato@zevanory.api.br" });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /PUBLIC_LEGACY_MAILBOX_PRESENT .*font\.woff2/);
});
