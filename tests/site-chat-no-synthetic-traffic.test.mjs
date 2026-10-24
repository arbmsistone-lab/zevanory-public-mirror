// Guarda estática: o banimento do WhatsApp veio de webhooks forjados pelo CI que fizeram o robô de produção
// mandar mensagens reais. O chat do site não pode repetir o padrão: nenhum workflow, script ou configuração
// de deploy pode gerar tráfego sintético contra o chat de produção, ligar a sandbox em produção ou ligar o
// chat por padrão. Testes do chat usam só fakes locais (tests/helpers/site-chat-fakes.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    if (st.isDirectory()) { if (n !== "node_modules" && n !== "__pycache__") walk(p, out); }
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
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      for (const [id, re] of rules) if (re.test(text)) findings.push(`${r}: ${id}`);
    }
  };
  check([...walk(join(root, ".github")), ...walk(join(root, "scripts"))], [...RULES, ...DEPLOY_RULES]);
  check(readdirSync(root).filter((n) => /^wrangler.*\.toml$/.test(n)).map((n) => join(root, n)), DEPLOY_RULES);
  return findings;
}

test("repositório: nenhum workflow/script/wrangler gera tráfego sintético no chat de produção, liga a sandbox ou liga o chat por padrão", () => {
  assert.deepEqual(scanSyntheticChatTraffic(ROOT), []);
});

test("a guarda pega cada padrão proibido (autoteste em diretório temporário)", () => {
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
      assert.ok(f.includes(want), "não detectou " + want + " em " + JSON.stringify(f));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("testes do chat só usam fakes locais: nenhum alvo de produção fora do handler/worker local, nenhum fetch real", () => {
  for (const f of ["tests/site-chat.test.mjs", "tests/site-chat-eval.test.mjs", "tests/helpers/site-chat-fakes.mjs", "tests/helpers/site-chat-eval.mjs"]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(text, /\bfetch\(\s*["'`]https?:/, f + ": fetch real");
    assert.doesNotMatch(text, /api\.resend\.com|DATABASE_URL\s*:\s*["']postgres/i, f + ": serviço real");
  }
});
