#!/usr/bin/env node
// ZEVANORY | P01 Fase A (AVAL 099 §2): gera/confere worker/fase-a-lia.generated.mjs a partir de docs/lgpd/LIA-fase-a.md.
// Uso: node scripts/fase_a/lia_manifest.mjs --write      (depois de editar ou aprovar a LIA)
//      node scripts/fase_a/lia_manifest.mjs --check      (CI: falha se o manifesto divergir do documento)
//      node scripts/fase_a/lia_manifest.mjs --self-test  (CI: prova que --check falha com a LIA alterada sem regenerar)
// O manifesto NÃO aprova nada: a ativação ainda exige FASE_A_LIA_APPROVED_SHA256 definida pelo proprietário.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LIA_FILE = path.join(ROOT, "docs", "lgpd", "LIA-fase-a.md");
export const GENERATED = path.join(ROOT, "worker", "fase-a-lia.generated.mjs");

export const liaText = (file = LIA_FILE) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
export const liaSha256 = (text) => crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n"), "utf8").digest("hex");
export async function buildManifest(text, guardModule = path.join(ROOT, "worker", "fase-a-lia.mjs")) {
  const { parseLia } = await import(pathToFileURL(guardModule).href);
  const p = parseLia(text);
  return { path: "docs/lgpd/LIA-fase-a.md", sha256: liaSha256(text), version: p.version, pending_marker: p.pending_marker, approval: p.approval };
}
export const render = (m) => `// GERADO por scripts/fase_a/lia_manifest.mjs a partir de ${m.path}; NÃO editar à mão (o CI confere).
// Não aprova nada: a medição só liga com FASE_A_LIA_APPROVED_SHA256 (proprietário) igual a sha256 abaixo.
export const LIA_FASE_A = Object.freeze(${JSON.stringify(m)});
`;

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const mode = process.argv[2];
  const want = render(await buildManifest(liaText()));
  if (mode === "--write") { fs.writeFileSync(GENERATED, want); console.log("LIA_MANIFEST=WRITTEN " + GENERATED); }
  else if (mode === "--check") {
    const have = fs.existsSync(GENERATED) ? fs.readFileSync(GENERATED, "utf8").replace(/\r\n/g, "\n") : "";
    if (have !== want) { console.log("::error title=LIA_MANIFEST_DRIFT::worker/fase-a-lia.generated.mjs diverge de docs/lgpd/LIA-fase-a.md; rode --write"); process.exit(1); }
    console.log("LIA_MANIFEST=IN_SYNC");
  } else if (mode === "--self-test") {
    // Prova negativa (roda dentro do check obrigatório): numa cópia temporária, LIA alterada sem regenerar => --check
    // falha com LIA_MANIFEST_DRIFT; cópia intacta e cópia regenerada => passam. Qualquer desvio => falha.
    const { spawnSync } = await import("node:child_process");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lia-gate-"));
    for (const rel of ["docs/lgpd/LIA-fase-a.md", "worker/fase-a-lia.mjs", "worker/fase-a-lia.generated.mjs", "scripts/fase_a/lia_manifest.mjs"]) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(tmp, rel));
    }
    const run = (m) => spawnSync(process.execPath, [path.join(tmp, "scripts", "fase_a", "lia_manifest.mjs"), m], { encoding: "utf8" });
    const intact = run("--check");
    fs.appendFileSync(path.join(tmp, "docs", "lgpd", "LIA-fase-a.md"), "\nEdição sem regenerar o manifesto.\n");
    const drift = run("--check");
    const write = run("--write"), regen = run("--check");
    fs.rmSync(tmp, { recursive: true, force: true });
    const ok = intact.status === 0 && drift.status === 1 && /LIA_MANIFEST_DRIFT/.test(drift.stdout) && write.status === 0 && regen.status === 0;
    console.log(`LIA_MANIFEST_SELF_TEST=${ok ? "PASS" : "FAIL"} intact=${intact.status} drift=${drift.status} regenerated=${regen.status}`);
    process.exit(ok ? 0 : 1);
  } else { console.error("uso: --write | --check | --self-test"); process.exit(2); }
}
