#!/usr/bin/env node
// T1 (roteiro seção 15, condição 1): detector AMPLIADO de caminhos capazes de escrever em produção na
// Cloudflare. Estático, sem rede, sem segredo: lê só arquivos do repositório.
//
// Classes (ops/publishers.json -> write_paths):
//   deploy     wrangler deploy | rollback | delete | versions upload | versions deploy; REST de escrita em
//              /workers/scripts/<nome> (conteúdo, versões, implantações, settings)
//   secret     wrangler secret put|delete|bulk e versions secret put|delete|bulk; REST .../secrets
//   config-kv  wrangler kv key put|delete e kv bulk put|delete (também kv:key/kv:bulk), salvo --local; REST /storage/kv
//   route      wrangler triggers deploy; REST /zones/<id>/workers/routes, /workers/domains, .../subdomain, .../schedules
//   d1         wrangler d1 execute | d1 migrations apply, salvo --local explícito (sem --local = remoto: fecha em
//              falha); REST /d1/database
//
// O que o detector vê (cada item tem fixture positiva e negativa em tests/t1-write-scan.test.mjs):
//   - continuação de linha com "\" (junta antes de analisar) e argumentos em lista de Python/Node
//     (["wrangler", "secret", "put"] e wrangler(["versions", "secret", "bulk"]));
//   - código embutido em heredoc (python3 - <<'PY' ... PY, node - <<'JS' ... JS): é texto do próprio workflow;
//   - REST: método de escrita (-X/--request, method=/method:, "PUT" em tupla, requests.put, curl com corpo
//     -d/--data/-F/-T/--json) a até WINDOW linhas lógicas de um caminho de escrita da API; num curl o caminho tem
//     de estar na mesma linha lógica ou numa variável atribuída no arquivo;
//   - scripts chamados pelos workflows (scripts/, ops/, tools/ com .py/.mjs/.js/.cjs/.sh), recursivamente, e
//     todo script sob scripts/ (operações manuais), atribuídos ao workflow pelo campo "via".
// O que NÃO vê (limites declarados, nunca PASS por omissão): URL montada fora do arquivo (só a base no texto),
// comando em variável ($WRANGLER deploy), Workers Builds e painel da Cloudflare (fora do repositório).
// Linhas inteiras de comentário (# ou //) são ignoradas; --dry-run exclui só deploy/versions upload.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CLASSES = ["config-kv", "d1", "deploy", "route", "secret"];
export const WINDOW = 10;
const SELF = "scripts/deploy/t1-write-scan.mjs";

const W = String.raw`(?:^|[\s"'(\[/;&|=` + "`" + String.raw`])wrangler(?:@[\w.^~-]+)?(?:\.cmd)?(?:[\s"'(\[,]+--?[A-Za-z][\w-]*(?:[= ](?!-)[^\s;&|"']+)?)*[\s"'(\[,]+`;
const WR = [
  { cls: "deploy", re: new RegExp(W + String.raw`(?:deploy|rollback|delete|versions[\s"',]+(?:upload|deploy))\b`), dry: true },
  { cls: "secret", re: new RegExp(W + String.raw`(?:versions[\s"',]+)?secret[\s"',]+(?:put|delete|bulk)\b`) },
  { cls: "config-kv", re: new RegExp(W + String.raw`kv(?::|[\s"',]+)(?:key|bulk)[\s"',]+(?:put|delete)\b`), local: true },
  { cls: "config-kv", re: new RegExp(W + String.raw`kv(?::|[\s"',]+)namespace[\s"',]+(?:create|delete|rename)\b`) },
  { cls: "route", re: new RegExp(W + String.raw`triggers[\s"',]+deploy\b`), dry: true },
  { cls: "d1", re: new RegExp(W + String.raw`d1[\s"',]+(?:execute|migrations[\s"',]+apply)\b`), local: true },
  // Publicador do painel que vive em outro repositório (clonado no job): não dá para ler, conta como deploy.
  { cls: "deploy", re: /\bnode\s[^\n]*cloudflare-authoritative-repair\.mjs/ },
];

// Caminhos de ESCRITA da API v4 (a classe vem do caminho; o método vem do marcador).
const PATHS = [
  { cls: "secret", re: /\/workers\/scripts\/[^/\s"'?]+\/secrets\b/ },
  { cls: "route", re: /\/zones\/[^/\s"'?]+\/workers\/routes\b|\/workers\/domains\b|\/workers\/scripts\/[^/\s"'?]+\/(?:subdomain|schedules)\b/ },
  { cls: "config-kv", re: /\/storage\/kv\/namespaces\b/ },
  { cls: "d1", re: /\/d1\/database\b/ },
  { cls: "deploy", re: /\/workers\/scripts\/[^/\s"'?]+(?:\/(?:content|versions|deployments|settings|script-settings))?(?![\w/-]*\/(?:secrets|subdomain|schedules)\b)(?=[\s"'?`)},]|$)/ },
];
const METHOD = /-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|--request[= ]['"]?(?:POST|PUT|PATCH|DELETE)\b|method\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)['"]|['"](?:POST|PUT|PATCH|DELETE)['"]|\brequests\.(?:post|put|patch|delete)\(|\bcurl\b[^\n]*\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file|--json)(?=[\s=])/;
const CURL = /\bcurl\b/;
const FOREIGN = /https?:\/\/(?!api\.cloudflare\.com)[\w.-]+/;

const isComment = (ln) => /^\s*(?:#|\/\/)/.test(ln) && !/^\s*#!/.test(ln);

// Linhas lógicas: remove linhas de comentário, junta continuação "\" e lembra a linha física inicial.
export function logicalLines(text) {
  const phys = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let buf = null;
  for (let i = 0; i < phys.length; i++) {
    const ln = phys[i];
    if (buf === null && isComment(ln)) continue;
    if (buf === null) buf = { line: i + 1, text: "" };
    if (/\\\s*$/.test(ln)) { buf.text += ln.replace(/\\\s*$/, " "); continue; }
    buf.text += ln;
    out.push(buf);
    buf = null;
  }
  if (buf) out.push(buf);
  return out;
}

// Lista de argumentos ["a", "b"] vira "a b" para os padrões do wrangler.
const flatten = (s) => s.replace(/['"]\s*,\s*['"]/g, " ");

// opts.python: crase não é sintaxe em Python; `wrangler deploy` entre crases é prosa (docstring) e sai.
export function scanText(text, opts = {}) {
  const lines = logicalLines(opts.python ? String(text).replace(/`[^`\n]*`/g, "``") : text);
  const found = [];
  const add = (cls, line, kind, snippet) => found.push({ cls, line, kind, snippet: snippet.trim().slice(0, 160) });
  // Variáveis atribuídas com caminho de escrita (VAR=..., VAR = ..., const VAR = ...).
  const pathVars = new Map();
  for (const l of lines) {
    // Só atribuição de TEXTO literal (aspas, crase, f-string): VAR="...", VAR = f"...", const VAR = `...`.
    const m = l.text.match(/^\s*(?:export\s+|local\s+|const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*:?=\s*((?:f|\$)?["'`].+)$/);
    if (!m) continue;
    for (const p of PATHS) if (p.re.test(m[2])) { pathVars.set(m[1], p.cls); break; }
  }
  // Função auxiliar que monta um caminho de escrita (kv(method, key), call(tok, method, url)...): uma chamada
  // dela com método de escrita conta, por longe que esteja da definição.
  const helpers = new Map();
  const DEF = /(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(|^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/;
  lines.forEach((l, idx) => {
    const m = l.text.match(/(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(|^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/);
    const name = m && (m[1] || m[2] || m[3] || m[4]);
    if (!name || /^(?:if|for|while|switch|catch|function|return)$/.test(name)) return;
    // Corpo = até a próxima definição; o primeiro endereço do corpo decide (URL de outro host encerra).
    for (let j = idx; j <= Math.min(lines.length - 1, idx + WINDOW); j++) {
      if (j > idx && DEF.test(lines[j].text)) break;
      const hit = PATHS.find((p) => p.re.test(lines[j].text));
      if (hit) { helpers.set(name, hit.cls); break; }
      if (FOREIGN.test(lines[j].text)) break;
    }
  });
  lines.forEach((l, idx) => {
    const flat = flatten(l.text);
    for (const w of WR) {
      if (!w.re.test(flat)) continue;
      if (w.dry && /--dry-run\b/.test(flat)) continue;
      if (w.local && /--local\b/.test(flat) && !/--remote\b/.test(flat)) continue;
      add(w.cls, l.line, "wrangler", l.text);
    }
    if (!METHOD.test(l.text)) return;
    const classes = new Set();
    if (CURL.test(l.text)) {
      for (const p of PATHS) if (p.re.test(l.text)) { classes.add(p.cls); break; }
      if (!classes.size) {
        for (const v of l.text.matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (pathVars.has(v[1])) classes.add(pathVars.get(v[1]));
      }
    } else {
      // O marcador pertence ao endereço mais próximo (caminho de escrita da API ou URL de outro host);
      // empate favorece a API da Cloudflare (fecha em falha). Variável com caminho na linha também vale.
      for (const v of l.text.matchAll(/\b([A-Za-z_]\w*)\b/g)) if (pathVars.has(v[1])) classes.add(pathVars.get(v[1]));
      for (const v of l.text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) if (helpers.has(v[1])) classes.add(helpers.get(v[1]));
      for (let d = 0; d <= WINDOW && !classes.size; d++) {
        const near = [idx - d, idx + d].filter((j, k) => j >= 0 && j < lines.length && (k === 0 || d > 0));
        let cf = null, other = false;
        for (const j of near) {
          const t = lines[j].text;
          if (CURL.test(t) && j !== idx) continue;
          const hit = PATHS.find((p) => p.re.test(t));
          if (hit) cf = cf || hit.cls;
          else if (FOREIGN.test(t)) other = true;
        }
        if (cf) classes.add(cf);
        else if (other) break;
      }
    }
    for (const c of classes) add(c, l.line, "rest", l.text);
  });
  return found;
}

const SCRIPT_REF = /(?:^|[\s"'=(:./$}])((?:scripts|ops|tools|sandbox|\.github\/scripts)\/[\w./-]+?\.(?:py|mjs|cjs|js|sh))\b/g;
// Qualquer arquivo do repositório executado por intérprete (bash x.sh, python3 -I y.py, node z.mjs); só conta se existir.
const INTERP_REF = /\b(?:bash|sh|python3?|node)\s+(?:-[\w-]+\s+)*["']?(?:\$\{?GITHUB_WORKSPACE\}?\/|\.\/)?([\w-][\w./-]*\.(?:py|mjs|cjs|js|sh))\b/g;
export function scriptRefs(text) {
  const refs = new Set();
  for (const l of logicalLines(text)) {
    // Item de lista de filtro (on.push.paths: - "scripts/x.py") não é chamada.
    if (/^\s*-\s*["']?[\w./*-]+["']?\s*$/.test(l.text)) continue;
    for (const m of l.text.matchAll(SCRIPT_REF)) refs.add(m[1].replace(/^\.\//, ""));
    // tests/ fica fora: arquivos de teste rodam com node --test/unittest e carregam fixtures (texto), não publicam.
    for (const m of l.text.matchAll(INTERP_REF)) if (!/^(?:\/|tests\/)/.test(m[1])) refs.add(m[1].replace(/^\.\//, ""));
  }
  return [...refs].sort();
}

const classesOf = (findings) => [...new Set(findings.map((f) => f.cls))].sort();

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "__pycache__" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.endsWith(x))) acc.push(p);
  }
  return acc;
}

// Varredura do repositório: { workflows: {nome: {classes, via, findings}}, scripts: {caminho: {classes, invoked_by}} }.
export function scanRepo(root) {
  const rel = (p) => relative(root, p).split(sep).join("/");
  const cache = new Map();
  const scanFile = (path) => {
    if (!cache.has(path)) {
      const abs = join(root, path);
      const text = existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, "utf8") : "";
      cache.set(path, { findings: path === SELF ? [] : scanText(text, { python: path.endsWith(".py") }), refs: scriptRefs(text).filter((r) => r !== path) });
    }
    return cache.get(path);
  };
  // Fecho transitivo dos scripts que um arquivo chama, com os que escrevem.
  const writersVia = (path, seen = new Set()) => {
    const out = new Set();
    for (const r of scanFile(path).refs) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (scanFile(r).findings.length) out.add(r);
      for (const x of writersVia(r, seen)) out.add(x);
    }
    return out;
  };
  const wfDir = join(root, ".github", "workflows");
  const workflows = {};
  const invokedBy = new Map();
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const path = `.github/workflows/${f}`;
    const own = scanFile(path).findings;
    const via = [...writersVia(path)].sort();
    for (const v of via) invokedBy.set(v, [...(invokedBy.get(v) || []), f]);
    const all = [...own, ...via.flatMap((v) => scanFile(v).findings)];
    if (all.length) workflows[f] = { classes: classesOf(all), via, findings: own.map((x) => ({ ...x, file: path })) };
  }
  const scripts = {};
  const candidates = new Set([...walk(join(root, "scripts"), [".py", ".mjs", ".cjs", ".js", ".sh"]).map(rel), ...invokedBy.keys()]);
  for (const p of [...candidates].sort()) {
    if (p === SELF) continue;
    const fs = scanFile(p).findings;
    if (!fs.length) continue;
    scripts[p] = { classes: classesOf(fs), invoked_by: (invokedBy.get(p) || []).sort(), findings: fs.map((x) => ({ ...x, file: p })) };
  }
  return { workflows, scripts };
}

// Qualquer segredo de token da Cloudflare (conta, dono público, por Worker, sonda sandbox).
const CRED = /secrets\.(?:CLOUDFLARE_[A-Z0-9_]*TOKEN[A-Z0-9_]*|CF_[A-Z0-9_]*TOKEN[A-Z0-9_]*)\b|secrets\[|toJSON\(\s*secrets\s*\)/;
const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
// Token por Worker (CF_TOKEN_<X>): só no(s) workflow(s) do serviço dono e na certificação de escopo (somente leitura).
// DEC-P20-D1-01: credenciais D1 dedicadas do diário (banco zevanory-diario-p20), do serviço zevanory; o passo exato
// que recebe cada uma é conferido por tests/test_diario_d1_credentials.py (ops/publishers.json -> d1_credentials).
export const TOKEN_OWNER = { CF_TOKEN_ZEVANORY: "zevanory", CF_TOKEN_SALES: "zevanory-sales-public", CF_TOKEN_ROUTER: "zevanory-public-router", CF_TOKEN_PANEL: "zevanory-product-control-portable",
  CF_TOKEN_D1_DIARIO_MIGRATE: "zevanory", CF_TOKEN_D1_DIARIO_READ: "zevanory" };
export const TOKEN_SCOPE_CERTIFIER = "t1-publisher-guard.yml";

// Confere o inventário (ops/publishers.json -> write_paths) contra a varredura. Devolve a lista de erros
// (vazia = coerente). Nenhuma rede; só arquivos.
export function checkInventory(root, registry = JSON.parse(readFileSync(join(root, "ops", "publishers.json"), "utf8")), scan = scanRepo(root)) {
  const errors = [];
  const err = (code, msg) => errors.push(`${code}: ${msg}`);
  const inv = registry.write_paths;
  if (!inv || typeof inv !== "object") return ["INVENTORY_MISSING: ops/publishers.json sem write_paths"];
  const wfs = inv.workflows || {}, scs = inv.scripts || {};
  for (const c of CLASSES) if (!(String(inv.guard_required?.[c] || "").length > 20)) err("GUARD_REQUIRED_MISSING", c);
  const services = registry.services || {};
  const serviceNames = new Set(Object.keys(services));
  const owner = new Map();
  for (const [svc, s] of Object.entries(services)) for (const w of [s.canonical, ...(s.config_publishers || []), ...(s.pending_owner_authorization || [])]) owner.set(w, svc);
  for (const w of Object.keys(registry.unserialized_known || {})) if (!owner.has(w)) owner.set(w, "unserialized");
  // Leitores registrados de uma credencial D1 SOMENTE LEITURA (services.<svc>.d1_credentials.roles.<papel>.readers, com
  // writes vazio): o workflow pode receber aquele token sem ser publicador do serviço. Papel com escrita nunca libera.
  const readers = new Map();
  for (const [svc, s] of Object.entries(services)) for (const role of Object.values(s.d1_credentials?.roles || {})) {
    if (!role || typeof role.secret !== "string" || !Array.isArray(role.writes) || role.writes.length !== 0 || !Array.isArray(role.readers)) continue;
    for (const rd of role.readers) if (rd && typeof rd.workflow === "string" && typeof rd.step === "string" && String(rd.reads || "").length > 10) readers.set(rd.workflow + "\n" + role.secret, svc);
  }
  const isolated = new Set(Object.values(registry.isolated || {}));
  const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const lineOf = (text, re) => { const ls = logicalLines(text); const hit = ls.find((l) => re.test(l.text)); return hit ? hit.line : null; };

  for (const [name, found] of Object.entries(scan.workflows)) {
    const e = wfs[name];
    if (!e) { err("UNREGISTERED_WRITE_PATH", `${name} (${found.classes.join(",")}) não está em write_paths`); continue; }
    if (!sameSet(e.classes, found.classes)) err("CLASS_MISMATCH", `${name}: inventário [${e.classes}] x detectado [${found.classes}]`);
    if (!sameSet(e.via, found.via)) err("VIA_MISMATCH", `${name}: inventário [${e.via}] x detectado [${found.via}]`);
  }
  for (const name of Object.keys(wfs)) if (!scan.workflows[name]) err("STALE_WRITE_PATH", `${name} registrado mas não escreve mais (ou não existe)`);
  for (const [path, found] of Object.entries(scan.scripts)) {
    const e = scs[path];
    if (!e) { err("UNREGISTERED_SCRIPT", `${path} (${found.classes.join(",")}) não está em write_paths.scripts`); continue; }
    if (!sameSet(e.classes, found.classes)) err("CLASS_MISMATCH", `${path}: inventário [${e.classes}] x detectado [${found.classes}]`);
    if (!sameSet(e.invoked_by, found.invoked_by)) err("INVOKED_BY_MISMATCH", `${path}: inventário [${e.invoked_by}] x detectado [${found.invoked_by}]`);
    if (e.role === "not-a-writer") {
      if (e.findings !== found.findings.length) err("NOT_A_WRITER_CHANGED", `${path}: ${found.findings.length} ocorrência(s), inventário fixa ${e.findings}; revise se virou escrita real`);
      if (!(String(e.note || "").length > 20)) err("NOTE_MISSING", path);
    } else if (e.role !== "writer") err("ROLE_INVALID", `${path}: ${e.role}`);
  }
  for (const path of Object.keys(scs)) if (!scan.scripts[path]) err("STALE_SCRIPT", `${path} registrado mas não escreve mais`);

  for (const [name, e] of Object.entries(wfs)) {
    if (!scan.workflows[name]) continue;
    const rel = `.github/workflows/${name}`;
    const text = read(rel);
    const hasCred = CRED.test(text);
    const own = scan.workflows[name].findings;
    if (e.scope === "no-credential") {
      if (hasCred) err("CREDENTIAL_IN_NO_CREDENTIAL", `${name} recebe credencial Cloudflare: reclassifique como production ou isolated`);
      continue;
    }
    if (e.scope !== "production" && e.scope !== "isolated") { err("SCOPE_INVALID", `${name}: ${e.scope}`); continue; }
    if (!hasCred) err("PRODUCTION_WITHOUT_CREDENTIAL", `${name}: escopo ${e.scope} sem credencial; use no-credential`);
    if (!["guarded", "gap"].includes(e.t1)) err("T1_STATUS_INVALID", `${name}: ${e.t1}`);
    if (e.t1 === "gap" && !(String(e.gap || "").length > 30)) err("GAP_REASON_MISSING", name);
    if (!(String(e.controls || "").length > 10)) err("CONTROLS_MISSING", name);
    if (e.scope === "isolated") {
      // O alvo aparece no workflow ou num script que ele chama (onde a escrita acontece).
      const viaTexts = (e.via || []).map((v) => read(v));
      if (!e.target || ![text, ...viaTexts].some((t) => t.includes(e.target))) err("ISOLATED_TARGET_MISSING", `${name}: alvo ${e.target} não aparece no arquivo nem nos scripts chamados`);
      if (serviceNames.has(e.target)) err("ISOLATED_TARGETS_PRODUCTION", `${name}: alvo ${e.target} é Worker de produção`);
      // Troca de alvo: nenhuma escrita do workflow isolado nomeia um Worker de produção.
      const viaFindings = (e.via || []).flatMap((v) => scan.scripts[v]?.findings || []);
      for (const f of [...own, ...viaFindings]) for (const svc of serviceNames) {
        if (new RegExp(String.raw`(?:--name[= ]|--script-name[= ]|workers/scripts/)["']?${svc.replace(/-/g, "\\-")}(?![\w-])`).test(f.snippet)) err("ISOLATED_TARGET_SWAP", `${name}:${f.line} escreve em ${svc}`);
      }
      continue;
    }
    // production
    const firstVia = (e.via || []).map((v) => lineOf(text, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).filter(Boolean);
    const pre = (e.pre_guard_isolated || []).map((x) => new RegExp(x.match));
    const prodWrites = [...own.filter((f) => !pre.some((re) => re.test(f.snippet))).map((f) => f.line), ...firstVia];
    const firstWrite = prodWrites.length ? Math.min(...prodWrites) : null;
    if (e.t1 === "guarded") {
      if (!Array.isArray(e.guard_evidence) || !e.guard_evidence.length) err("GUARD_EVIDENCE_MISSING", name);
      for (const g of e.guard_evidence || []) {
        const at = lineOf(text, new RegExp(g));
        if (at === null) err("GUARD_ABSENT", `${name}: guard /${g}/ não encontrado`);
        else if (firstWrite !== null && at > firstWrite) err("GUARD_AFTER_WRITE", `${name}: guard na linha ${at}, escrita de produção na linha ${firstWrite}`);
      }
      for (const x of e.pre_guard_isolated || []) if (!(String(x.reason || "").length > 20)) err("PRE_GUARD_REASON_MISSING", name);
    }
    const cls = new Set(e.classes);
    if ((cls.has("deploy") || cls.has("secret")) && !String(e.service || "").startsWith("kv:")) {
      if (!serviceNames.has(e.service)) err("SERVICE_UNKNOWN", `${name}: serviço ${e.service}`);
      if (!owner.has(name) && !isolated.has(name)) err("PUBLISHER_NOT_IN_REGISTRY", `${name} publica ${[...cls]} em ${e.service} e não está em services/unserialized_known`);
    }
  }
  // Todo publicador do registro de serviços aparece aqui como produção (ou isolado).
  for (const [w] of owner) if (!wfs[w] || !["production", "isolated"].includes(wfs[w].scope)) err("REGISTRY_PUBLISHER_NOT_INVENTORIED", w);
  for (const w of isolated) if (!wfs[w] || wfs[w].scope !== "isolated") err("REGISTRY_ISOLATED_NOT_INVENTORIED", w);
  // Token por Worker só no serviço dono (troca de token = escrita em outro Worker).
  const wfDir = join(root, ".github", "workflows");
  for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = read(`.github/workflows/${f}`);
    for (const m of text.matchAll(/secrets\.(CF_TOKEN_[A-Z0-9_]+)\b/g)) {
      const svc = TOKEN_OWNER[m[1]];
      if (f === TOKEN_SCOPE_CERTIFIER) continue;
      if (!svc) { err("TOKEN_UNKNOWN", `${f}: ${m[1]} sem dono em TOKEN_OWNER`); continue; }
      if (readers.get(f + "\n" + m[1]) === svc) continue;
      if (owner.get(f) !== svc) err("TOKEN_CROSS_WORKER", `${f} usa ${m[1]} (dono ${svc}) mas é ${owner.get(f) || "não registrado"}`);
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv.slice(2).find((a) => !a.startsWith("--")) || fileURLToPath(new URL("../../", import.meta.url));
  const res = scanRepo(root);
  const json = process.argv.includes("--json");
  if (process.argv.includes("--check")) {
    const errors = checkInventory(root, undefined, res);
    for (const e of errors) console.log("::error title=T1_WRITE_PATH::" + e);
    console.log("T1_WRITE_PATHS_CHECK=" + (errors.length ? "FAIL" : "PASS") + " errors=" + errors.length);
    process.exit(errors.length ? 1 : 0);
  }
  if (json) {
    process.stdout.write(JSON.stringify(res, null, 1) + "\n");
  } else {
    console.log("| Caminho | Classes | Via / chamado por |");
    console.log("|---|---|---|");
    for (const [k, v] of Object.entries(res.workflows)) console.log(`| ${k} | ${v.classes.join(", ")} | ${v.via.join(", ") || "-"} |`);
    for (const [k, v] of Object.entries(res.scripts)) console.log(`| ${k} | ${v.classes.join(", ")} | ${v.invoked_by.join(", ") || "manual"} |`);
    console.log("T1_WRITE_SCAN=" + JSON.stringify({ workflows: Object.keys(res.workflows).length, scripts: Object.keys(res.scripts).length }));
  }
}
