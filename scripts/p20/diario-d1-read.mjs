// ZEVANORY | P20 diário D1 (docs/p20/diario-d1.md, seção "Ensaio mensal lê o diário"): leitura SOMENTE LEITURA do
// diário de eventos críticos para o ensaio mensal de restauração.
//
//   node scripts/p20/diario-d1-read.mjs --out "$RUNNER_TEMP/p20/diario.json"
//
// Usa SÓ o token dedicado CF_TOKEN_D1_DIARIO_READ (D1 Read, DEC-P20-D1-01), entregue SÓ ao passo do workflow que roda
// este script. Só a API REST POST /accounts/<conta>/d1/database/<id>/query, com duas consultas SELECT fixas (a cabeça e
// uma página de linhas por seq); nenhuma outra SQL é aceita pelo leitor. Lê a cabeça primeiro e depois as linhas até o
// seq da cabeça: como o diário é somente inclusão, o resultado é um retrato consistente.
// Sem o segredo: grava {estado:"sem_token"} e sai 0 (o ensaio mantém diario_d1 em NOT_COVERED, com o motivo).
// Saída: arquivo 0600 no RUNNER_TEMP (lido pelo passo seguinte do mesmo job; nunca vira artefato). As linhas do diário
// não têm dado pessoal por construção (ids técnicos e HMAC); nada delas vai para o log.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const SCHEMA_LEITURA = "zevanory.p20.diario-leitura.v1";
export const D1_ACCOUNT = "1b26415802588185a86c1d4d3ebf5bdb";
export const D1_DATABASE_ID = "1b1bfa19-ccc5-423a-bc1f-62d89020c8e2"; // zevanory-diario-p20
export const D1_QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/${D1_ACCOUNT}/d1/database/${D1_DATABASE_ID}/query`;
export const SQL_HEAD = "select seq, chain_hash from diario_head where id = 1";
export const SQL_PAGINA = "select seq, event_key, tipo, ts_ms, ref, payload_json, payload_sha, prev_hash, chain_hash from diario_v1 where seq > ? and seq <= ? order by seq limit ?";
export const SQL_PERMITIDAS = Object.freeze([SQL_HEAD, SQL_PAGINA]);
export const PAGINA = 1000;
export const MAX_PAGINAS = 200; // 200 mil linhas: muito acima do volume previsto; acima disso "incompleto"
const clean = (s) => String(s || "").replace(/[^A-Za-z0-9_.:,= -]/g, "").slice(0, 160);

export function d1Query({ token, fetchImpl = fetch }) {
  if (typeof token !== "string" || token.length < 20) throw new Error("d1_token_unavailable");
  return async (sql, params = []) => {
    if (!SQL_PERMITIDAS.includes(sql)) throw new Error("d1_sql_nao_permitida");
    const r = await fetchImpl(D1_QUERY_URL, {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "user-agent": "zevanory-p20-diario-read/1" },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(60000),
    });
    if (r.status !== 200) throw new Error("d1_http_" + r.status);
    const body = await r.json().catch(() => null);
    const res = Array.isArray(body?.result) ? body.result[0] : null;
    if (body?.success !== true || !res || res.success === false || !Array.isArray(res.results)) throw new Error("d1_resposta_invalida");
    return res.results;
  };
}

// -> {schema, estado: "lido"|"incompleto"|"sem_token"|"erro", lido_em, head, rows, consultas, motivo?}
export async function lerDiario({ token, fetchImpl = fetch, now = () => new Date(), pagina = PAGINA, maxPaginas = MAX_PAGINAS } = {}) {
  const base = { schema: SCHEMA_LEITURA, database_id: D1_DATABASE_ID };
  if (!token) return { ...base, estado: "sem_token", lido_em: now().toISOString(), head: null, rows: [], consultas: 0, motivo: "CF_TOKEN_D1_DIARIO_READ ausente" };
  let q;
  try { q = d1Query({ token, fetchImpl }); } catch (e) { return { ...base, estado: "erro", lido_em: now().toISOString(), head: null, rows: [], consultas: 0, motivo: clean(e?.message) }; }
  const lidoEm = now().toISOString();
  let consultas = 0;
  try {
    const [head] = await q(SQL_HEAD);
    consultas++;
    if (!head || !Number.isSafeInteger(Number(head.seq))) return { ...base, estado: "erro", lido_em: lidoEm, head: null, rows: [], consultas, motivo: "diario_sem_cabeca" };
    const topo = Number(head.seq);
    const rows = [];
    let cursor = 0, completo = topo === 0;
    while (!completo && consultas < maxPaginas + 1) {
      const page = await q(SQL_PAGINA, [cursor, topo, pagina]);
      consultas++;
      rows.push(...page);
      if (page.length < pagina) completo = true;
      else cursor = Number(page[page.length - 1].seq);
    }
    return { ...base, estado: completo ? "lido" : "incompleto", lido_em: lidoEm, head: { seq: topo, chain_hash: String(head.chain_hash) }, rows, consultas, ...(completo ? {} : { motivo: "paginas_excedidas" }) };
  } catch (e) {
    return { ...base, estado: "erro", lido_em: lidoEm, head: null, rows: [], consultas, motivo: clean(e?.message) };
  }
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

export async function main() {
  const out = arg("--out");
  if (!out) throw new Error("uso: --out arquivo");
  const r = await lerDiario({ token: process.env.CF_TOKEN_D1_DIARIO_READ || "" });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(r) + "\n", { mode: 0o600 });
  const resumo = JSON.stringify({ estado: r.estado, head_seq: r.head?.seq ?? null, linhas: r.rows.length, consultas: r.consultas, motivo: r.motivo ?? null });
  console.log((r.estado === "lido" ? "::notice" : "::warning") + " title=P20_DIARIO_D1_LEITURA::" + resumo);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((c) => process.exit(c)).catch((e) => { console.log("::warning title=P20_DIARIO_D1_LEITURA::" + clean(e?.message || e)); process.exit(0); });
