// The repository planner (scripts/indexnow-publication.mjs, via indexnow-submit.yml) is the ONLY IndexNow
// submitter: one URL per request, journal, continuity anchor and daily cap. Dynamic blog pages remain publishable
// but must not bypass those controls. NC-G6-1026-02: every IndexNow endpoint is blocked here, not only
// api.indexnow.org (participating engines accept submissions directly at <engine>/indexnow).
export const INDEXNOW_HOSTS = Object.freeze(["api.indexnow.org", "indexnow.org", "www.bing.com", "bing.com", "yandex.com", "www.yandex.com", "search.seznam.cz", "searchadvisor.naver.com", "indexnow.yep.com", "yep.com", "indexnow.amazonbot.amazon"]);
export function isIndexNowEndpoint(input) {
  let url;
  try { url = new URL(typeof input === "string" ? input : input.url); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return host === "api.indexnow.org" || host === "indexnow.org" || (INDEXNOW_HOSTS.includes(host) && /\/indexnow\/?$/i.test(url.pathname)) || /(^|\.)indexnow\./i.test(host);
}
export function withoutDirectIndexNow(fetchImpl){
 return (input,options)=>{
  if(isIndexNowEndpoint(input))return Promise.resolve(Response.json({accepted:false,code:'indexnow_journal_required'},{status:409}));
  return fetchImpl(input,options);
 };
}
