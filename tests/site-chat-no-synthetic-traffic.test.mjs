// Guarda estática: o banimento do WhatsApp veio de webhooks forjados pelo CI que fizeram o robô de produção
// mandar mensagens reais. O chat do site não pode repetir o padrão: nenhum workflow, script ou configuração
// de deploy pode gerar tráfego sintético contra o chat de produção, ligar a sandbox em produção ou ligar o
// chat por padrão. Testes do chat usam só fakes locais (tests/helpers/site-chat-fakes.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readTextNormalized } from "./helpers/text.mjs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Arquivo que pode citar os padrões porque descreve mutações locais (nunca executa contra produção).
const ALLOW = new Set(["scripts/ci/mutants_site_chat.py"]);
const RULES = [
  ["chat_endpoint", /\/api\/chat\b/i],
  ["chat_binding_host", /chat\.internal/i],
  ["synthetic_header", /x-zevanory-synthetic|x-zev-synthetic|x-synthetic-test/i],
  ["sandbox_flag", /SITE_CHAT_SANDBOX/],
];
const DEPLOY_RULES = [
  ["enabled_by_default", /SITE_CHAT_ENABLED\s*[=:]\s*["']?true/i],
  ["sandbox_in_deploy", /SITE_CHAT_SANDBOX/],
];

function walk(dir, out = []) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) { if (n !== "node_modules" && n !== "__pycache__" && n !== ".git") walk(p, out); }
    else if (st.size < 2_000_000) out.push(p);
  }
  return out;
}
export function scanSyntheticChatTraffic(root) {
  const findings = [];
  const rel = (p) => relative(root, p).split(sep).join("/");
  const check = (files, rules) => {
    for (const f of files) {
      const r = rel(f);
      if (ALLOW.has(r)) continue;
      let text = "";
      try { text = readTextNormalized(f); } catch { continue; }
      for (const [id, re] of rules) if (re.test(text)) findings.push(`${r}: ${id}`);
    }
  };
  check([...walk(join(root, ".github")), ...walk(join(root, "scripts"))], [...RULES, ...DEPLOY_RULES]);
  check(readdirSync(root).filter((n) => /^wrangler.*\.toml$/.test(n)).map((n) => join(root, n)), DEPLOY_RULES);
  return findings;
}

test("SG01 repositório: nenhum workflow/script/wrangler gera tráfego sintético no chat de produção, liga a sandbox ou liga o chat por padrão", () => {
  assert.deepEqual(scanSyntheticChatTraffic(ROOT), [], "[SG01.1]");
});

test("SG02 a guarda pega cada padrão proibido (autoteste em diretório temporário)", () => {
  const bad = {
    ".github/workflows/smoke.yml": "jobs:\n  s:\n    steps:\n      - run: curl -X POST https://vendas.zevanory.api.br/api/chat -d '{\"message\":\"oi\"}'\n",
    "scripts/probe.mjs": "await fetch('https://chat.internal/api/chat/session')\n",
    "scripts/fake.sh": "curl -H 'x-zevanory-synthetic: 1' https://zevanory.api.br/\n",
    ".github/workflows/deploy.yml": "env:\n  SITE_CHAT_SANDBOX: 'true'\n",
    "wrangler.sales.toml": "[vars]\nSITE_CHAT_ENABLED = \"true\"\n",
  };
  const dir = mkdtempSync(join(tmpdir(), "zc-guard-"));
  try {
    for (const [p, body] of Object.entries(bad)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), body); }
    const f = scanSyntheticChatTraffic(dir);
    for (const want of [".github/workflows/smoke.yml: chat_endpoint", "scripts/probe.mjs: chat_binding_host", "scripts/fake.sh: synthetic_header", ".github/workflows/deploy.yml: sandbox_flag", "wrangler.sales.toml: enabled_by_default"])
      assert.ok(f.includes(want), "[SG02.1] " + ("não detectou " + want + " em " + JSON.stringify(f)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SG03 testes do chat só usam fakes locais: nenhum alvo de produção fora do handler/worker local, nenhum fetch real", () => {
  for (const f of ["tests/site-chat.test.mjs", "tests/site-chat-eval.test.mjs", "tests/helpers/site-chat-fakes.mjs", "tests/helpers/site-chat-eval.mjs"]) {
    const text = readTextNormalized(join(ROOT, f));
    assert.doesNotMatch(text, /\bfetch\(\s*["'`]https?:/, "[SG03.1] " + (f + ": fetch real"));
    assert.doesNotMatch(text, /api\.resend\.com|DATABASE_URL\s*:\s*["']postgres/i, "[SG03.2] " + (f + ": serviço real"));
  }
});

// Padrão DESLIGADO (Sol, #897): o chat só pode ser ligado por decisão explícita, nunca por um valor padrão.
// Fontes que podem ligar o chat: a política (enabled_default), qualquer wrangler*.toml, scripts que geram
// configuração ou páginas (scripts/build_sales_public.py, scripts/deploy/*), workflows e o código dos Workers.
// Comentários de linha inteira (// ou #) são ignorados: descrevem a regra, não a aplicam.
const ENABLE_TRUE = /SITE_CHAT_ENABLED["']?\s*[=:]\s*["']?\s*true\b/i;
const ENABLE_DEFAULT_TRUE = /SITE_CHAT_ENABLED\s*(?:\|\||\?\?)\s*["'`]?\s*true\b|SITE_CHAT_ENABLED\s*,\s*["'`]true["'`]\s*\)/i;
const STATIC_INJECTION = /<script[^>]*site-chat\.js|<link[^>]*site-chat\.css|site-chat\.js" defer/i;
const stripLineComments = (text) => text.split("\n").filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l)).join("\n");
export function scanSiteChatDefaultEnabled(root) {
  const findings = [];
  const rel = (p) => relative(root, p).split(sep).join("/");
  const read = (p) => { try { return readTextNormalized(p); } catch { return null; } };
  let policy = null;
  try { policy = JSON.parse(read(join(root, "data/site-chat-policy.json")) || "null"); } catch {}
  if (!policy || policy.enabled_default !== false) findings.push("data/site-chat-policy.json: enabled_default");
  const all = walk(root).filter((p) => !rel(p).startsWith(".git/"));
  for (const f of all.filter((p) => /(^|\/)wrangler[^/]*\.toml$/.test(rel(p)))) {
    const text = stripLineComments(read(f) || "");
    for (const m of text.matchAll(/SITE_CHAT_ENABLED["']?\s*[=:]\s*(["']?)([^"'\s,}]*)\1/gi)) if (m[2].toLowerCase() !== "false") findings.push(`${rel(f)}: wrangler_enabled`);
  }
  for (const f of all.filter((p) => /^(scripts|\.github|worker)\//.test(rel(p)) && !ALLOW.has(rel(p)))) {
    const text = stripLineComments(read(f) || "");
    if (ENABLE_TRUE.test(text)) findings.push(`${rel(f)}: sets_enabled_true`);
    if (ENABLE_DEFAULT_TRUE.test(text)) findings.push(`${rel(f)}: defaults_enabled_true`);
    if (/^scripts\//.test(rel(f)) && STATIC_INJECTION.test(text)) findings.push(`${rel(f)}: generator_injects_widget`);
  }
  for (const f of all.filter((p) => /^sales-public\/[^/]+\.html$/.test(rel(p)))) if (/site-chat\.(js|css)/.test(read(f) || "")) findings.push(`${rel(f)}: static_page_loads_chat`);
  return [...new Set(findings)];
}

test("SG04 padrão desligado: política, wrangler, gerador, workflows e Workers não ligam o chat por padrão", () => {
  assert.deepEqual(scanSiteChatDefaultEnabled(ROOT), [], "[SG04.1]");
  const policy = JSON.parse(readTextNormalized(join(ROOT, "data/site-chat-policy.json")));
  assert.equal(policy.enabled_default, false, "[SG04.2]");
});

test("SG05 a guarda do padrão desligado pega cada fonte (autoteste em diretório temporário, com controle positivo)", () => {
  const clean = {
    "data/site-chat-policy.json": JSON.stringify({ enabled_default: false }),
    "wrangler.sales.toml": "[vars]\nSITE_CHAT_ENABLED = \"false\"\n# SITE_CHAT_ENABLED = \"true\" só por decisão do proprietário\n",
    "scripts/build_sales_public.py": "for asset in (\"site-chat.js\", \"site-chat.css\"):\n    copy(asset)\n",
    "worker/sales-public-worker.mjs": "export const siteChatEnabled=env=>String(env?.SITE_CHAT_ENABLED||\"\").toLowerCase()===\"true\";\n",
    "sales-public/ia-na-pratica.html": "<html><body>suporte@zevanory.api.br</body></html>",
  };
  const bad = {
    "data/site-chat-policy.json": JSON.stringify({ enabled_default: true }),
    "wrangler.sales.toml": "[vars]\nSITE_CHAT_ENABLED = \"true\"\n",
    "sandbox/x/wrangler.toml": "[vars]\nSITE_CHAT_ENABLED = 1\n",
    "scripts/deploy/prepare.py": "VARS = {\"SITE_CHAT_ENABLED\": \"true\"}\n",
    "scripts/build_sales_public.py": "html = html.replace(\"</body>\", '<script src=\"/site-chat.js\" defer></script></body>')\n",
    "worker/site-chat.mjs": "const enabledEnv = String(env.SITE_CHAT_ENABLED ?? \"true\").toLowerCase() === \"true\";\n",
    ".github/workflows/deploy.yml": "env:\n  SITE_CHAT_ENABLED: true\n",
    "sales-public/ia-na-pratica.html": "<html><head><link rel=\"stylesheet\" href=\"/site-chat.css\"></head></html>",
  };
  const write = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "zc-default-"));
    for (const [p, body] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), body); }
    return dir;
  };
  const okDir = write(clean), badDir = write(bad);
  try {
    assert.deepEqual(scanSiteChatDefaultEnabled(okDir), [], "[SG05.1] controle positivo: \"false\" e comentários não acusam");
    const f = scanSiteChatDefaultEnabled(badDir);
    for (const want of ["data/site-chat-policy.json: enabled_default", "wrangler.sales.toml: wrangler_enabled", "sandbox/x/wrangler.toml: wrangler_enabled", "scripts/deploy/prepare.py: sets_enabled_true",
      "scripts/build_sales_public.py: generator_injects_widget", "worker/site-chat.mjs: defaults_enabled_true", ".github/workflows/deploy.yml: sets_enabled_true", "sales-public/ia-na-pratica.html: static_page_loads_chat"])
      assert.ok(f.includes(want), "[SG05.2] " + ("não detectou " + want + " em " + JSON.stringify(f)));
  } finally { rmSync(okDir, { recursive: true, force: true }); rmSync(badDir, { recursive: true, force: true }); }
});
