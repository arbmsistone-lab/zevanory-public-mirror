// Diagnóstico só de leitura da sonda Hotmart no runner (22/11/2026). Sem segredos, sem escrita.
// (1) roda probeHotmart + classifyHotmartProbe do código do PR; (2) para cada checkout, GET com redirect:"manual"
// e registra status e Location (host + caminho + errorMessage; nunca o resto da query) e se o Location é URL válida.
import { probeHotmart } from "./command-center-snapshot.mjs";
import { classifyHotmartProbe } from "./funnel-counting.mjs";
const URLS = { "ia-na-pratica": "https://pay.hotmart.com/F107979716H?off=g9knd34r", "vendas-na-pratica": "https://pay.hotmart.com/Y107979937I?off=8mg88sdd", "lucro-e-caixa": "https://pay.hotmart.com/L107979973K?off=ksb5di36", "combo-ia-vendas": "https://pay.hotmart.com/H107979990T?off=b3ytmah4", "negocio-completo": "https://pay.hotmart.com/U107980005X?off=weo47apk", "conteudo-pronto": "https://pay.hotmart.com/X107980075B?off=4ydutio7" };
const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "accept-language": "pt-BR" };
const seguro = (loc, base) => { try { const u = new URL(loc, base); return { valido: true, host: u.host, path: u.pathname.slice(0, 40), errorMessage: u.searchParams.get("errorMessage") }; } catch { return { valido: false, bruto_len: String(loc).length, tem_espaco: /\s/.test(String(loc)), nao_ascii: /[^\x20-\x7e]/.test(String(loc)) }; } };
const sonda = (await probeHotmart()).map((p) => ({ slug: p.slug, etapa: p.etapa, http: p.http, cause: p.cause, finalHost: p.finalHost, finalPath: p.finalPath, errorCode: p.errorCode, classe: classifyHotmartProbe(p) }));
console.log("::notice title=SONDA_HOTMART::" + JSON.stringify(sonda));
const diag = [];
for (const [slug, url] of Object.entries(URLS)) {
  try {
    const r = await fetch(url, { redirect: "manual", headers: UA, signal: AbortSignal.timeout(15000) });
    const loc = r.headers.get("location");
    diag.push({ slug, status: r.status, location: loc == null ? null : seguro(loc, url) });
  } catch (e) { diag.push({ slug, erro: String(e?.name || "erro"), causa: String(e?.cause?.code || e?.cause?.name || "").slice(0, 40) }); }
}
console.log("::notice title=SONDA_REDIRECT::" + JSON.stringify(diag));
const fechados = sonda.filter((x) => x.classe === "closed").length, inc = sonda.filter((x) => x.classe !== "closed" && x.classe !== "accepting").length;
console.log(`SONDA_RESUMO closed=${fechados} inconclusive_or_error=${inc} accepting=${sonda.filter((x) => x.classe === "accepting").length}`);
