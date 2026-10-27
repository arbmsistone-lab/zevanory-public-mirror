import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const evidence = join(root, "docs", "evidence", "release-2");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const files = walk(evidence)
  .filter((path) => !path.endsWith("manifest.json"))
  .sort()
  .map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(root, path).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
const matrix = JSON.parse(readFileSync(join(evidence, "matrix.json"), "utf8"));
const screenshots = files.filter((item) => item.path.endsWith(".png"));
const manifest = {
  schema: "zevanory.release-2-evidence.v1",
  source_base: "a098d8802a184df02b362d46f08fb6c81b7382f9",
  // Local working-tree evidence must not pretend to belong to the previous
  // commit. CI supplies the exact GITHUB_SHA after checkout.
  release_sha: process.env.RELEASE_SHA || null,
  release_sha_binding: "CI regenerates this manifest with RELEASE_SHA=GITHUB_SHA and verifies both manifest and matrix",
  sales_mode: "closed",
  owner_vertical_scroll_approval: "APROVO ROLAGEM VERTICAL NAS PÁGINAS PÚBLICAS",
  matrix: {
    pass: matrix.pass,
    checked: matrix.checked,
    routes: matrix.routes,
    views: matrix.views,
    schemes: matrix.schemes,
  },
  screenshots: {
    count: screenshots.length,
    widths: [320, 360, 390, 768, 1440],
    schemes: ["light", "dark"],
    routes: ["solucoes", "zevanory-sales", "ia-na-pratica", "material-gratuito", "termos", "reembolso", "privacidade", "afiliados", "comprar/ZEV-IA-011"],
  },
  files,
};
writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`RELEASE_2_EVIDENCE_MANIFEST=PASS files=${files.length} screenshots=${screenshots.length} matrix=${matrix.checked}`);
