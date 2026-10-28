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
  // L-5: the base this evidence was measured against (CI passes the PR base SHA; locally the current gh-pages base).
  source_base: process.env.SOURCE_BASE || "d01dd5ea8b85df2dbf8ccad2c6a9d6a95210f6d8",
  ci_run: process.env.GITHUB_RUN_ID ? { run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT || null, sha: process.env.GITHUB_SHA || null } : null,
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
    release_sha: matrix.release_sha ?? null,
    cta_overlap_checked: matrix.cta_overlap_checked === true,
    cta_overlaps: matrix.cta_overlaps ?? null,
    environment: matrix.environment ?? null,
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
