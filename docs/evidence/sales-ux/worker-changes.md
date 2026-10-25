# Sales Worker changes in #914 (functional audit)

File: `worker/sales-public-worker.mjs`. Base: the gh-pages blob `9e7e708aac4e7ea28de07a410bfcd44e9df71a68`.
#914 changes the Worker in exactly **two hunks**. Nothing else in the file changes. This is proven by
`tests/sales-worker-differential.test.mjs`, which reverse-applies the two hunks to the current file and
checks that the result has that exact git blob id.

## 1. Designed 404 for unknown page paths

The new block sits right after `env.ASSETS.fetch(...)`:

```js
if(response.status===404&&!page&&(request.method==="GET"||request.method==="HEAD")&&!/\.[a-z0-9]{1,8}$/i.test(url.pathname)){
  const nf=await env.ASSETS.fetch(new Request(new URL("/404.html",request.url),{method:"GET"}));
  if(nf.status===200) return new Response(request.method==="HEAD"?null:nf.body,{status:404,headers:applySecurityHeaders(new Headers({"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex"}))});
}
```

| | gh-pages | #914 |
|---|---|---|
| GET/HEAD of an unknown page path (no file extension), e.g. `/pagina-que-nao-existe`, `/nao/existe/` | 404, body `Not found` from ASSETS | **404**, body is the designed `/404.html`; `content-type: text/html; charset=utf-8`, **`cache-control: no-store`**, **`x-robots-tag: noindex`**, same security headers and CSP (`applySecurityHeaders`) |
| Unknown asset path (has an extension), e.g. `/assets/nao-existe.0123456789.css` | plain 404 | unchanged (plain 404) |
| Other methods (POST, etc.) to unknown paths | plain 404 | unchanged |
| Known pages, `/` | 200 | unchanged |
| `/api/*`, `/admin`, `/comprar/*` (literal and encoded aliases), `/assinar/*`, `/hotmart/*`, `/reembolso/solicitar`, `/health`, `/arbm-sist` tombstone, retired routes | handled before the ASSETS fetch | unchanged (they return before this block is reached) |
| `/robots.txt`, `/sitemap.xml`, `/llms.txt`, the retired contact-script path, `/termos`, `/privacidade`, `/reembolso` | 200 | unchanged |

`/404.html` is never cached, so a later real page at that path is never masked. If `404.html` were missing,
the Worker falls back to the old plain 404.

## 2. Hotmart variant: list wording for the hero payment facts

The design turned the hero's "·" chain into a list (`<ul class="buy-facts">`) and gave the trust block a
"Pagamento" line. The `HOTMART_TEXT` pairs (Mercado Pago wording, Hotmart wording) used by the Hotmart
variant now target those strings:

| Removed pair (gh-pages) | Added pairs (#914) |
|---|---|
| `Pagamento pelo Mercado Pago (Pix ou cartão) · entrega por e-mail em ${DELIVERY_72H} · arrependimento em 7 dias corridos.` → `Pagamento pela Hotmart (Pix, cartão ou boleto) · acesso por e-mail após a confirmação · arrependimento em 7 dias corridos.` | `Pagamento processado pelo Mercado Pago (Pix ou cartão)` → `Pagamento processado pela Hotmart (Pix, cartão ou boleto)` |
| | `Entrega por e-mail em ${DELIVERY_72H}` → `Acesso por e-mail após a confirmação do pagamento` |
| | `<strong>Pagamento</strong><span>processado pelo Mercado Pago` → `<strong>Pagamento</strong><span>processado pela Hotmart` |

- The rewrite only runs in the Hotmart variant. That variant is served at `/hotmart/<slug>`, and only while
  sales are open. With sales closed (P13 NO-GO), `/hotmart/*` behaves exactly as on gh-pages.
- Every other page keeps the Mercado Pago text exactly as built.
- The 7-day line is shared by both providers, so it is no longer rewritten.

## Not changed (byte-identical behaviour)

- Security headers and CSP (`applySecurityHeaders`, `CSP`), on every route.
- The cache policy from #911: immutable hashed assets, a 1-day policy for images, short revalidating pages,
  and the tombstone's `no-store` plus `Clear-Site-Data`.
- The P13 closed build: no `/comprar/` link, no checkout, no `InStock`, waiting-list CTAs. The open-mode
  rewrite (`data-zev-open-text` → `/comprar/<sku>`) is unchanged.
- The `/comprar/*` buy flow (confirmation step, automation block, noindex/nofollow/no-store, encoded aliases),
  `/assinar/*`, `/api/sales/status` passthrough, UTM propagation, robots/sitemap, contact script.

## Evidence

- `tests/sales-worker-differential.test.mjs`. Both Workers (gh-pages, rebuilt and hash-verified, and #914)
  answer the same matrix: every built page, five trailing-slash variants, four unknown paths, `/api/*`,
  `/admin`, five `/comprar/*` forms, `/assinar`, two `/hotmart/*` slugs, `/reembolso/solicitar`, hashed CSS
  and preview, a missing asset, `/product.css`, robots, sitemap, the retired contact-script path, `/llms.txt`, the
  favicon, `/health` and the `/arbm-sist` tombstone. The matrix runs with GET and HEAD, sales closed and
  open: 412 request pairs in total. The test compares status, every header and body bytes. It fails on
  any difference other than (1) on the four unknown paths and (2) on `/hotmart/*` GET while open, where
  headers must still be identical.
  - Named sub-tests:
    - (a) the 404 scope;
    - (b) the Hotmart-only rewrite;
    - (c) sales closed means no buy CTA, `/comprar` link, checkout or `InStock` on any page;
    - (d) checkout and purchase routes are identical to gh-pages, closed and open;
    - (e) security headers and CSP are identical.
- `tests/sales-design.test.mjs` (a): the built `404.html` contract.

## Marketing PR (#924, stacked on #914): niche landing pages

Third intended difference, asserted by `tests/sales-worker-differential.test.mjs`: `/para/salao`, `/para/oficina`,
`/para/clinica` and `/para/loja` (with or without trailing slash) now serve `para-<ramo>.html` with status 200,
the same CSP and `no-store, no-transform` (they follow the sales switch like the other priced pages). Before they
were 404. The flat file names (`/para-salao`) and unknown niches (`/para/barbearia`, `/para/constructor`) stay
designed 404s. No other route, header or body changes.
