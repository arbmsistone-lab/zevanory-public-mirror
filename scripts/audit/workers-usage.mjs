// ZEVANORY | P19 (Roteiro Mestre v4.7, seções 5 e 11): uso de Workers da CONTA no último dia UTC completo.
// Somente leitura: uma consulta GraphQL Analytics (workersInvocationsAdaptive) com o token que o command-center já usa
// para a cota de KV (kvOperationsAdaptiveGroups). Nenhuma escrita, nenhum dado pessoal. Sem escopo, sem dado ou
// resposta malformada = {verified:false, reason}; nunca um número estimado.
//   requests: soma de todas as invocações de todos os Workers da conta (limite Workers Free: 100 mil/dia por conta).
//   cpu: cpuTimeP99 por Worker (microssegundos na API -> ms aqui); o pior p99 entre os Workers com requisições é o
//        valor conservador (não existe p99 da conta somando quantis). Limite do Free: 10 ms por invocação.
export const WORKERS_DAILY_REQUEST_LIMIT = 100000;
export const WORKERS_CPU_LIMIT_MS = 10;

export const prevUtcDay = (now = Date.now()) => new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - 86400000).toISOString().slice(0, 10);

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

// Pura: agrega os grupos por Worker devolvidos pela API. Qualquer grupo malformado invalida a leitura inteira.
export function summarizeWorkersGroups(groups, day) {
  if (!Array.isArray(groups)) return { verified: false, day, reason: "groups_not_array" };
  // A conta sempre tem tráfego (sites e crons): lista vazia é falta de escopo ou de dado, nunca "zero requisições".
  if (groups.length === 0) return { verified: false, day, reason: "no_groups" };
  const scripts = {};
  for (const g of groups) {
    const name = g?.dimensions?.scriptName;
    const req = g?.sum?.requests, err = g?.sum?.errors, sub = g?.sum?.subrequests, p99 = g?.quantiles?.cpuTimeP99, p50 = g?.quantiles?.cpuTimeP50;
    if (typeof name !== "string" || !name || !Number.isInteger(req) || req < 0 || !Number.isInteger(err) || err < 0 || !isNum(p99) || !isNum(p50)) {
      return { verified: false, day, reason: "group_malformed" };
    }
    const s = scripts[name] || (scripts[name] = { requests: 0, errors: 0, subrequests: 0, cpu_p99_ms: 0, cpu_p50_ms: 0 });
    s.requests += req; s.errors += err; s.subrequests += Number.isInteger(sub) && sub >= 0 ? sub : 0;
    s.cpu_p99_ms = Math.max(s.cpu_p99_ms, Math.round(p99 / 10) / 100);
    s.cpu_p50_ms = Math.max(s.cpu_p50_ms, Math.round(p50 / 10) / 100);
  }
  const list = Object.entries(scripts).filter(([, s]) => s.requests > 0);
  const requests = list.reduce((a, [, s]) => a + s.requests, 0);
  const worst = list.reduce((w, [n, s]) => (s.cpu_p99_ms > w.ms ? { ms: s.cpu_p99_ms, script: n } : w), { ms: 0, script: null });
  return {
    verified: true, day,
    requests, errors: list.reduce((a, [, s]) => a + s.errors, 0),
    limit: WORKERS_DAILY_REQUEST_LIMIT, pct: Math.round((requests / WORKERS_DAILY_REQUEST_LIMIT) * 1000) / 10,
    cpu_p99_ms_worst: worst.ms, cpu_p99_worst_script: worst.script, cpu_limit_ms: WORKERS_CPU_LIMIT_MS,
    scripts: list.length,
    top: list.sort((a, b) => b[1].requests - a[1].requests).slice(0, 8).map(([n, s]) => ({ script: n.slice(0, 63), requests: s.requests, cpu_p99_ms: s.cpu_p99_ms })),
  };
}

export const WORKERS_QUERY = "query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_lt:$e}){sum{requests errors subrequests}quantiles{cpuTimeP50 cpuTimeP99}dimensions{scriptName}}}}}";

export async function workersUsageForDay(day, { token = process.env.CLOUDFLARE_API_TOKEN, account = process.env.CLOUDFLARE_ACCOUNT_ID, fetchImpl = fetch } = {}) {
  if (!token || !account) return { verified: false, day, reason: "token_or_account_missing" };
  try {
    const r = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST", // GraphQL de leitura (consulta), igual à da cota de KV; nenhuma mutação
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ query: WORKERS_QUERY, variables: { a: account, s: day + "T00:00:00Z", e: new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().replace(".000Z", "Z") } }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await r.json().catch(() => null);
    const groups = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    if (!Array.isArray(groups)) return { verified: false, day, reason: String(body?.errors?.[0]?.message || "http_" + r.status).replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 80) };
    return summarizeWorkersGroups(groups, day);
  } catch (e) { return { verified: false, day, reason: String(e?.name || "error") }; }
}
