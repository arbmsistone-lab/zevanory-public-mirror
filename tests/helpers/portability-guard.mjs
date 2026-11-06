// Verificador estático de portabilidade de tests/*.test.mjs (AVAL Sol 081, #865). Funções puras sobre o
// texto-fonte, para que o guarda (tests/guards/portability.test.mjs) prove também que detecta violações.
//
// Regras:
//  R1 TEXT_READ_WITHOUT_HELPER: arquivo que lê texto com fs (readFileSync/readFile + "utf8") e aplica regex
//     tem de importar readTextNormalized de ./helpers/text.mjs — salvo se estiver em TEXT_READ_ALLOWLIST.
//  R2 ADHOC_EOL_REPLACE: arquivo que usa o helper não pode repetir .replace(/\r\n/g, ...) ad hoc.
//  R3 STALE_ALLOWLIST: entrada da allowlist que já usa o helper ou não lê texto com regex é removida.
//  R4 TOOL_WITHOUT_PREFLIGHT: spawn/exec literal de python3, python, jq ou bash exige requireTool(<tool>).
//  R5 FIXED_TMP_PATH: caminho fixo "/tmp" ou "C:\tmp" é proibido; use mkdtemp sob os.tmpdir().

// R1 — arquivos que leem texto e aplicam regex SEM o helper, aceitos por evidência: todos passaram com
// checkout CRLF (node-suite-windows, core.autocrlf=true, run 39852693175: 573/573) e no Linux com
// core.autocrlf=true simulado. Suas regex não atravessam fim de linha. Ao editar um destes arquivos,
// migre para readTextNormalized e remova a entrada (R3 obriga quando o helper passa a ser usado).
// trava-vendas-gate-paths: fica fora por desenho — ele prova estaticamente o fecho de importações do gate
// integracao e um import do helper acrescentaria uma leitura não literal ao fecho; normaliza inline.
export const TEXT_READ_ALLOWLIST = new Set([
  "acquisition-engine.test.mjs",
  "automation-traffic-guard.test.mjs",
  "brand-profiles.test.mjs",
  "certification-worker.test.mjs",
  "creative-autonomy.test.mjs",
  "data-backup.test.mjs",
  "db-economy.test.mjs",
  "financial-ddl-readonly.test.mjs",
  "financial-proof-invalidation-evidence.test.mjs",
  "hotmart-pages.test.mjs",
  "instant-status-sales-coherence.test.mjs",
  "lead-magnet.test.mjs",
  "link-vencido-nao-reutilizado.test.mjs",
  "live-runtime-status.test.mjs",
  "mercadopago-preference-expiry.test.mjs",
  "mercadopago-webhook-safety.test.mjs",
  "operational-activity.test.mjs",
  "order22-isolated-financial-proof-evidence.test.mjs",
  "order7-whatsapp-commercial.test.mjs",
  "politica-honrar-pagamento.test.mjs",
  "product-consistency.test.mjs",
  "production-staging-health.test.mjs",
  "sandbox_credential_isolation.test.mjs",
  "sandbox_proof_v2.test.mjs",
  "short-crosspost.test.mjs",
  "start-guide-touch-target.test.mjs",
  "trava-vendas-gate-paths.test.mjs",
  "trust-chain-no-false-green.test.mjs",
  "voice-eval.test.mjs",
  "whatsapp-neon-store.test.mjs",
  "youtube-daily-short.test.mjs",
]);

const READS_TEXT = (s) => /\breadFile(?:Sync)?\s*\(/.test(s) && /["']utf-?8["']/i.test(s);
const USES_REGEX = (s) => /assert\.(?:doesNot)?[mM]atch\b|\.matchAll\(|\.match\(|new RegExp\(|\/[^/\n]+\/[gimsuy]*\.test\(/.test(s);
const USES_HELPER = (s) => /import\s*\{[^}]*\breadTextNormalized\b[^}]*\}\s*from\s*["']\.\/helpers\/text\.mjs["']/.test(s);
const ADHOC_EOL = /\.replace\(\s*\/\\r\\n\/g/;
const TOOLS = ["python3", "python", "jq", "bash"];

export function checkFile(name, src, allowlist = TEXT_READ_ALLOWLIST) {
  const problems = [];
  const helper = USES_HELPER(src), needs = READS_TEXT(src) && USES_REGEX(src);
  if (needs && !helper && !allowlist.has(name)) problems.push(`TEXT_READ_WITHOUT_HELPER ${name}`);
  if (helper && ADHOC_EOL.test(src)) problems.push(`ADHOC_EOL_REPLACE ${name}`);
  if (allowlist.has(name) && (helper || !needs)) problems.push(`STALE_ALLOWLIST ${name}`);
  for (const m of src.matchAll(/\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\(\s*["'`]([\w.-]+)/g)) {
    const tool = m[1];
    if (TOOLS.includes(tool) && !new RegExp(`requireTool\\(\\s*["']${tool.replace(".", "\\.")}["']`).test(src)) problems.push(`TOOL_WITHOUT_PREFLIGHT ${name}: ${tool}`);
  }
  if (/["'`]\/tmp(?:\/|["'`])|["'`]C:\\\\tmp/i.test(src)) problems.push(`FIXED_TMP_PATH ${name}`);
  return problems;
}
