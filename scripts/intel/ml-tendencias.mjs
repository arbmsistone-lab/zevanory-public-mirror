// Mercado Livre como FONTE DE DEMANDA (Plano Mestre, canal 15; ordem executiva 14/11: só preparação).
// Somente leitura das tendências de busca do ML Brasil (GET /trends/MLB). Nada é anunciado nem vendido no ML: a política
// de PI do ML veda PDF e o desvio para a Hotmart dá suspensão. O sinal entra no relatório semanal como EVIDÊNCIA
// (palavras reais que casam com cada ramo), sem mexer nos pesos do score.
// Token: a API do ML pode exigir "Authorization: Bearer"; o token (aplicação ML do proprietário) é opcional aqui. Sem
// token ou com recusa da API, o status diz exatamente isso (sem_token/http_401/http_403...) e nenhum sinal é inventado.
export const ML_TRENDS_URL = "https://api.mercadolibre.com/trends/MLB";
const GENERICAS = new Set(["para", "shop", "loja", "lojas", "clinica", "escritorio", "escola", "curso", "livre", "servico", "materiais", "assistencia", "tecnica", "estudio", "nail", "designer", "corretor", "hotel", "agencia", "design", "interiores", "distribuidora"]);
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
export function termosRamo(nome) {
  return [...new Set(norm(nome).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !GENERICAS.has(w)).map((w) => w.slice(0, w.length >= 9 ? 7 : 5)))];
}
export async function lerTendencias({ token = "", fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  let r;
  try { r = await fetchImpl(ML_TRENDS_URL, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { return { status: "rede_" + String(e?.name || "erro").replace(/[^A-Za-z]/g, ""), autenticado: !!token, palavras: [] }; }
  if (!r || r.status !== 200) return { status: (r?.status === 401 || r?.status === 403) && !token ? "sem_token" : "http_" + (r?.status ?? "sem_resposta"), autenticado: !!token, palavras: [] };
  const j = await r.json().catch(() => null);
  if (!Array.isArray(j)) return { status: "formato_invalido", autenticado: !!token, palavras: [] };
  const palavras = j.filter((x) => typeof x?.keyword === "string" && x.keyword.trim()).slice(0, 100).map((x) => ({ keyword: x.keyword.trim().slice(0, 80), url: typeof x.url === "string" && /^https:\/\/[a-z0-9.-]*mercadoli[bv]re\.com(\.br)?\//.test(x.url) ? x.url : null }));
  return { status: palavras.length ? "ok" : "vazio", autenticado: !!token, palavras };
}
// Evidência por ramo: palavras do ML que contêm um termo do nome do ramo. Não altera o score.
export function casarRamos(guias, palavras) {
  const out = [];
  for (const g of guias) {
    const termos = termosRamo(g.name);
    const achadas = palavras.filter((p) => termos.some((t) => norm(p.keyword).split(/[^a-z0-9]+/).some((w) => w.startsWith(t)))).map((p) => p.keyword);
    if (achadas.length) out.push({ slug: g.slug, name: g.name, palavras_ml: achadas.slice(0, 5) });
  }
  return out;
}
