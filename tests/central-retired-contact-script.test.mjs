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
import { retiredPublicAssetResponse, RETIRED_CONTACT_SCRIPT, RETIRED_CONTACT_BODY, RETIRED_CONTACT_CLEAR_SITE_DATA } from "../worker/retired-public-assets.mjs";

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

test("(b) generator: no published copy, every reference stripped, e-mail rewrite kept only where the script ran", () => {
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
  assert.equal(r.read("d.html"), '<p><a href="mailto:contato@zevanory.api.br">contato@zevanory.api.br</a></p>\n', "a page that never loaded the script is unchanged");
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
