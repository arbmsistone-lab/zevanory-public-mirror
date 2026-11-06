// ZEVANORY | Blog shell (zevanory.api.br/blog, central Worker): the same identity as the sales site
// (product.css tokens of docs/design/sales-site-identity.md: receipt paper, ink, the R$ 100 blue, the counter
// bar), light and dark by prefers-color-scheme, skip link, landmarks, one h1, visible focus, 44 px targets.
// Site audit C-03: the blog used to be bare HTML with no stylesheet, header, footer or navigation.
//
// The apex CSP is `style-src 'self'; font-src 'self'` and the apex assets are the frozen public/ snapshot,
// so the stylesheet is served by the Worker itself (BLOG_CSS at BLOG_CSS_PATH, immutable: the path carries
// the first 10 hex of the SHA-256 of BLOG_CSS, pinned by tests/blog-layout.test.mjs) and the fonts are the
// metric-matched local fallbacks the sales CSS already declares (no cross-origin font).
import { CONTACT_HTML, LEGAL_IDENTITY } from "./politica-unica.mjs";

export const SALES_ORIGIN = "https://vendas.zevanory.api.br";
export const BLOG_CSS_PATH = "/blog-assets/blog.e89bd68cf9.css";
// Logo for the dark counter bar (apex public/brand, overlaid with the official export at deploy).
export const BLOG_LOGO_PATH = "/brand/zevanory-logo-dark.svg";

export const BLOG_CSS = `/* ZEVANORY blog: sales identity tokens (product.css), no web fonts (apex font-src 'self'). */
:root{color-scheme:light dark;--papel:#eef2f5;--cupom:#ffffff;--tinta:#0e1a2b;--grafite:#4a5568;--azul-cedula:#1a5a96;--amarelo-caixa:#ffc72c;--sobre-amarelo:#0e1a2b;--linha:#7a8899;--linha-suave:#c5cfda;--balcao:#0e1a2b;--balcao-texto:#ffffff;--regua:#0e1a2b;--display:"Arial Narrow",Arial,"Liberation Sans",sans-serif;--texto:Verdana,"DejaVu Sans",Arial,sans-serif;font-family:var(--texto);line-height:1.6;-webkit-text-size-adjust:100%;text-size-adjust:100%}
@media (prefers-color-scheme:dark){:root{--papel:#0d1723;--cupom:#16212f;--tinta:#eef2f5;--grafite:#b3bfcc;--azul-cedula:#8fc1ef;--linha:#7d8ea3;--linha-suave:#34475c;--balcao:#08111c;--regua:#9fb0c3}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--papel);overflow-x:clip}
body{margin:0;background:var(--papel);color:var(--tinta);font-size:1.0625rem;overflow-x:clip;display:flex;flex-direction:column;min-height:100vh}
img{display:block;max-width:100%;height:auto}
a{color:var(--azul-cedula);text-decoration-thickness:1px;text-underline-offset:.2em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--azul-cedula);outline-offset:3px}
.skip-link{position:fixed;left:16px;top:12px;z-index:100;transform:translateY(-200%);padding:12px 16px;background:var(--amarelo-caixa);color:var(--sobre-amarelo);font-weight:700;border:2px solid var(--sobre-amarelo)}
.skip-link:focus{transform:none}
.wrap{width:min(1120px,100% - 32px);margin-inline:auto}
.site-header{background:var(--balcao);color:var(--balcao-texto)}
.header-inner{min-height:64px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.5rem 1.5rem;padding-block:.5rem}
.brand{display:inline-flex;align-items:center;min-height:44px}
.brand img{width:140px;height:auto}
.site-nav{display:flex;flex-wrap:wrap;align-items:center;gap:0 1.25rem}
.site-nav a,.footer-nav a{display:inline-flex;align-items:center;min-height:44px;color:var(--balcao-texto);font-weight:700;text-decoration:none}
.site-nav a:hover,.footer-nav a:hover,.site-nav a[aria-current="page"]{text-decoration:underline;text-underline-offset:.3em}
.site-header :focus-visible,.site-footer :focus-visible{outline-color:var(--amarelo-caixa)}
main{flex:1 0 auto;padding-block:2.5rem 3.5rem}
.blog-main{max-width:46rem}
h1,h2,h3{font-family:var(--display);font-weight:700;line-height:1.15;letter-spacing:-.01em;text-wrap:balance;margin:0}
h1{font-size:clamp(1.9rem,4.6vw,2.8rem);margin-bottom:.75rem}
h2{font-size:clamp(1.35rem,2.6vw,1.75rem);margin:2.25rem 0 .75rem}
h3{font-size:1.2rem;margin:1.5rem 0 .5rem}
p,li{max-width:66ch;text-wrap:pretty}
.lead{font-size:1.125rem;color:var(--grafite)}
.byline{color:var(--grafite);font-size:.9375rem}
.post-list{list-style:none;margin:2rem 0 0;padding:0;display:grid;gap:1rem}
.post-list article{background:var(--cupom);border:1px solid var(--linha);border-radius:6px;padding:1.25rem 1.25rem 1rem}
.post-list h2{font-size:1.35rem;margin:0 0 .5rem}
.post-list p{margin:0 0 .5rem}
.post-list time{color:var(--grafite);font-size:.9375rem}
.empty{background:var(--cupom);border:1px solid var(--linha);border-radius:6px;padding:1.25rem;margin-top:2rem}
.empty p{margin:0 0 .75rem}
.empty ul{margin:0;padding-left:1.25rem}
.empty li{margin:.25rem 0}
.empty a,.next-steps a{display:inline-flex;align-items:center;min-height:44px}
.post-hero{margin:1.5rem 0;border:1px solid var(--linha-suave);border-radius:6px}
.next-steps{margin-top:2.5rem;padding-top:1.5rem;border-top:2px solid var(--regua)}
.next-steps ul{padding-left:1.25rem}
.sales-closed{background:var(--cupom);border-left:4px solid var(--amarelo-caixa);padding:.75rem 1rem;color:var(--tinta)}
.breadcrumb{margin:0 0 1rem;font-size:.9375rem}
.breadcrumb a{display:inline-flex;align-items:center;min-height:44px}
.site-footer{background:var(--balcao);color:var(--balcao-texto);font-size:.9375rem}
.footer-inner{padding-block:1.5rem 2rem;display:grid;gap:.75rem}
.footer-inner p{margin:0;max-width:none}
.site-footer a{color:var(--balcao-texto)}
.footer-nav{display:flex;flex-wrap:wrap;gap:0 1.25rem}
@media (max-width:480px){.brand img{width:120px}.site-nav{gap:0 1rem}}
@media print{.skip-link,.site-nav{display:none!important}.site-header,.site-footer{background:#fff;color:#000}.site-footer a{color:#000}}
`;

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const NAV = [
  ["Soluções", SALES_ORIGIN + "/solucoes"],
  ["Guias por ramo", SALES_ORIGIN + "/ia-por-ramo"],
  ["Blog", "/blog"],
];
const FOOTER_NAV = [
  ["Quem criou", SALES_ORIGIN + "/quem-criou"],
  ["Termos", SALES_ORIGIN + "/termos"],
  ["Privacidade", SALES_ORIGIN + "/privacidade"],
  ["Reembolso", SALES_ORIGIN + "/reembolso"],
];

export function blogCssResponse(request) {
  const head = request?.method === "HEAD";
  return new Response(head ? null : BLOG_CSS, { status: 200, headers: {
    "content-type": "text/css; charset=utf-8",
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  } });
}

// head: extra <head> markup (already escaped). main: inner HTML of <main> (already escaped).
export function blogShell({ title, description, canonical = "", robots = "", head = "", main, current = "" }) {
  const nav = NAV.map(([label, href]) => `<a href="${esc(href)}"${current === href ? ' aria-current="page"' : ""}>${esc(label)}</a>`).join("");
  const foot = FOOTER_NAV.map(([label, href]) => `<a href="${esc(href)}">${esc(label)}</a>`).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="light dark"><meta name="theme-color" content="#0e1a2b">`
    + `<title>${esc(title)}</title><meta name="description" content="${esc(description)}">`
    + (robots ? `<meta name="robots" content="${esc(robots)}">` : "")
    + (canonical ? `<link rel="canonical" href="${esc(canonical)}">` : "")
    + `<link rel="icon" href="/brand/export/avatar-400.png" type="image/png"><link rel="stylesheet" href="${BLOG_CSS_PATH}">${head}</head>`
    + `<body><a class="skip-link" href="#conteudo">Ir para o conteúdo</a>`
    + `<header class="site-header"><div class="wrap header-inner"><a class="brand" href="${SALES_ORIGIN}/solucoes"><img src="${BLOG_LOGO_PATH}" alt="ZEVANORY" width="156" height="40"></a>`
    + `<nav class="site-nav" aria-label="Navegação principal">${nav}</nav></div></header>`
    + `<main id="conteudo" class="wrap"><div class="blog-main">${main}</div></main>`
    + `<footer class="site-footer"><div class="wrap footer-inner"><p><strong>ZEVANORY</strong> · Menos improviso. Mais execução.</p>`
    + `<p>${esc(LEGAL_IDENTITY)}</p><p>Contato: ${CONTACT_HTML}</p><nav class="footer-nav" aria-label="Links institucionais">${foot}</nav></div></footer>`
    + `</body></html>`;
}
