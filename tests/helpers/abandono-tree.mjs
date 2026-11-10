// Cópia de worker/ e data/ num diretório temporário único, com constantes de CÓDIGO trocadas (ABANDONO_STAGE,
// KIT_ORDER_INGEST_ENABLED), para exercitar o roteamento real em "aquecimento"/"ativo" sem mudar o repositório.
// Cada troca precisa casar exatamente uma vez (âncora única), senão lança. O repositório nunca é alterado.
import { cpSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readTextNormalized } from "./text.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function patchedTree(patches) {
  const dir = mkdtempSync(join(tmpdir(), "abandono-arvore-"));
  for (const d of ["worker", "data"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  for (const [rel, oldText, newText] of patches) {
    const f = join(dir, rel);
    const src = readTextNormalized(f);
    if (src.split(oldText).length !== 2) throw new Error("âncora não única em " + rel + ": " + oldText.slice(0, 60));
    writeFileSync(f, src.replace(oldText, newText), "utf8");
  }
  return { dir, load: (rel) => import(pathToFileURL(join(dir, rel)).href), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export const STAGE_ANCHOR = 'export const ABANDONO_STAGE = "desligado";';
export const stagePatch = (stage) => ["worker/abandono-hotmart.mjs", STAGE_ANCHOR, `export const ABANDONO_STAGE = "${stage}";`];
export const KIT_INGEST_PATCH = ["worker/kit-nc015-ingress.mjs", "export const KIT_ORDER_INGEST_ENABLED=false;", "export const KIT_ORDER_INGEST_ENABLED=true;"];
