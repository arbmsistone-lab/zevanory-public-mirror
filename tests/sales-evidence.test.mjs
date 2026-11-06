// Sol 232 (#914): the committed sales-UX evidence is complete and consistent with the gates.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTextNormalized } from "./helpers/text.mjs";

const EV = join(fileURLToPath(new URL("..", import.meta.url)), "docs/evidence/sales-ux");
const PAGES = ["/solucoes", "/lucro-e-caixa", "/vendas-na-pratica", "/ia-na-pratica", "/conteudo-pronto", "/combo-ia-vendas", "/negocio-completo", "/zevanory-sales", "/termos", "/quem-criou"];

test("budget-results.json: 10 public pages x mobile/desktop x light/dark, every budget met", () => {
  const r = JSON.parse(readTextNormalized(join(EV, "budget-results.json")));
  assert.equal(r.schema, "zevanory.sales-budget-results.v1");
  assert.deepEqual(Object.keys(r.themes).sort(), ["dark", "light"]);
  assert.equal(r.pass, true);
  for (const [theme, t] of Object.entries(r.themes)) {
    assert.deepEqual(Object.keys(t.pages).sort(), [...PAGES].sort(), theme);
    for (const p of PAGES) for (const d of ["mobile", "desktop"]) {
      const row = t.pages[p][d], k = `${theme} ${d} ${p}`;
      assert.ok(row.lighthouse.median.performance >= r.budget.performance, k);
      for (const c of ["accessibility", "best-practices", "seo"]) assert.equal(row.lighthouse.min[c], 100, `${k} ${c}`);
      assert.equal(row.axe.serious_critical, 0, k);
      for (const f of ["targets_under_44px", "focus_issues", "reduced_motion_issues", "scroll_exception_issues", "console_errors"]) assert.equal(row[f], 0, `${k} ${f}`);
      assert.equal(row.color_scheme_emulated, true, k);
    }
  }
});

test("scroll-gate-results.json: 10 pages + designed 404, 5 viewports, both themes, all pass", () => {
  const r = JSON.parse(readTextNormalized(join(EV, "scroll-gate-results.json")));
  assert.equal(r.pass, true);
  assert.equal(r.checked, 110);
  for (const scheme of ["light", "dark"]) {
    for (const p of [...PAGES, "/pagina-inexistente"]) assert.equal(r.rows.filter((x) => x.scheme === scheme && x.route === p && x.pass).length, 5, `${scheme} ${p}`);
    assert.ok(r.rows.filter((x) => x.scheme === scheme && x.route === "/pagina-inexistente").every((x) => x.http === 404), "404 answers 404");
  }
});

test("worker-changes.md documents the two hunks and names the gh-pages blob", () => {
  const md = readTextNormalized(join(EV, "worker-changes.md"));
  for (const s of ["9e7e708aac4e7ea28de07a410bfcd44e9df71a68", "Designed 404", "Hotmart variant", "tests/sales-worker-differential.test.mjs", "no-store", "noindex"]) assert.ok(md.includes(s), s);
});
