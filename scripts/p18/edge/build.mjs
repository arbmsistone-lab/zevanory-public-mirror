// Gera supabase/functions/p18-leitura-br/index.ts (arquivo ÚNICO, colável no editor do painel do Supabase) a partir de:
// scripts/b0/p18-commercial.mjs (regras do verificador, só sem os imports node:* e sem o main da CLI), as listas
// data/p18-commercial-allowlist.json e data/p18-hotmart-direct-authorization.json (embutidas) e
// scripts/p18/edge/leitura-br.mjs. Grava no cabeçalho o sha256 de cada fonte; tests/p18-leitura-br.test.mjs exige que o
// arquivo versionado seja exatamente a saída deste gerador (nada editado à mão).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const OUT = "supabase/functions/p18-leitura-br/index.ts";
const sha = (s) => createHash("sha256").update(s).digest("hex");
export function build(root = ROOT) {
  const verifier = readFileSync(join(root, "scripts/b0/p18-commercial.mjs"), "utf8");
  const allow = readFileSync(join(root, "data/p18-commercial-allowlist.json"), "utf8");
  const direct = readFileSync(join(root, "data/p18-hotmart-direct-authorization.json"), "utf8");
  const handler = readFileSync(join(root, "scripts/p18/edge/leitura-br.mjs"), "utf8");
  const v = verifier.replace(/^import [^\n]* from "node:[^"]+";\n/gm, "").replace(/\nif \(import\.meta\.url === pathToFileURL[^\n]*\n?$/, "\n");
  if (/from "node:/.test(v) || /process\.argv/.test(v.split("\nasync function main")[1]?.split("\n}\n")[1] || "")) throw new Error("verifier_strip_failed");
  const h = handler.replace(/^import \{[\s\S]*?\} from "\.\.\/\.\.\/b0\/p18-commercial\.mjs";\n/m, "");
  if (/from "/.test(h)) throw new Error("handler_has_imports");
  const meta = { verifier_sha256: sha(verifier), allowlist_sha256: sha(allow), direct_sha256: sha(direct), handler_sha256: sha(handler) };
  const out = `// @ts-nocheck
// GERADO por scripts/p18/edge/build.mjs — NÃO EDITAR À MÃO. Edge Function Supabase "p18-leitura-br" (ZEVANORY).
// Somente GET; só os 6 links fixos da lista autorizada; sem cookie, sem sessão da Hotmart, sem segredo.
// Fontes: ${Object.entries(meta).map(([k, x]) => k + "=" + x).join(" ")}
// ---------------------------------------------------------------- verificador oficial (regras)
${v}
// ---------------------------------------------------------------- leitura a partir de São Paulo
${h}
// ---------------------------------------------------------------- servidor
const ALLOW = ${allow.trim()};
const DIRECT = ${direct.trim()};
const META = ${JSON.stringify(meta)};
Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "only_get" }), { status: 405, headers: { "content-type": "application/json", allow: "GET" } });
  if (u.search) return new Response(JSON.stringify({ error: "no_parameters" }), { status: 400, headers: { "content-type": "application/json" } });
  const region = Deno.env.get("SB_REGION") ?? null;
  const r = await leituraBr({ allow: ALLOW, direct: DIRECT, region, verifier: META });
  return new Response(JSON.stringify(r), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
`;
  return { out, meta };
}
if (import.meta.url === new URL("file://" + process.argv[1]).href) {
  const { out, meta } = build();
  mkdirSync(join(ROOT, dirname(OUT)), { recursive: true });
  writeFileSync(join(ROOT, OUT), out);
  console.log("P18_LEITURA_BR_BUILD " + OUT + " " + Object.entries(meta).map(([k, x]) => k + "=" + x.slice(0, 12)).join(" ") + " bundle_sha256=" + sha(out));
}
