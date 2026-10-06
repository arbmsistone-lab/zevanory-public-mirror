// Deterministic creative compositor: text-free Workers AI background + exact catalog typography.
// The model never writes text; every word on the image comes from the published sales page.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const ORIGIN = 'https://controle.zevanory.api.br';
const SLUGS = ['ia-na-pratica', 'vendas-na-pratica', 'lucro-e-caixa', 'combo-ia-vendas', 'negocio-completo'];
const secret = process.env.CERTIFICATION_E2E_TOKEN || '';
if (secret.length < 32) throw new Error('T2_CERTIFICATION_TOKEN_UNAVAILABLE');
const out = process.env.T2_OUT || 't2-output';
fs.mkdirSync(out, { recursive: true });

const sign = (parts) => createHmac('sha256', secret).update(parts.join('\n')).digest('hex');
function factoryHeaders() {
  const ts = String(Date.now()), nonce = randomUUID();
  return { 'x-commercial-timestamp': ts, 'x-commercial-nonce': nonce, 'x-commercial-signature': sign(['zevanory-commercial-creative-factory-v1', ts, nonce]) };
}
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = (v) => String(v).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function catalog(slug) {
  const r = await fetch('https://vendas.zevanory.api.br/' + slug, { headers: { accept: 'text/html', 'cache-control': 'no-store' } });
  if (!r.ok) throw new Error('CATALOG_HTTP_' + r.status + '_' + slug);
  const html = await r.text();
  const title = decode((html.match(/<title>([^<]+)<\/title>/i)?.[1] || '').trim());
  const description = decode((html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1] || '').trim());
  const price = (html.match(/Pre[cç]o de tabela:\s*R\$\s*(\d+)/i)?.[1] || '').trim();
  const name = title.split('|')[0].trim();
  if (!name || !description || !price) throw new Error('CATALOG_PARSE_' + slug);
  return { name, description, price };
}

function headline(description) {
  const first = description.split(/(?<=[.!?])\s+/)[0];
  return first.length <= 150 ? first : description;
}

const font = (w) => fs.readFileSync(path.join('node_modules/@fontsource/inter/files', `inter-latin-${w}-normal.woff2`)).toString('base64');
const fonts = { 400: font(400), 600: font(600), 800: font(800) };

function page({ name, description, price, slug, bg, bgMime }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${[400, 600, 800].map((w) => `@font-face{font-family:Inter;font-weight:${w};src:url(data:font/woff2;base64,${fonts[w]}) format('woff2')}`).join('\n')}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1080px;height:1080px;overflow:hidden;background:#050a1e;font-family:Inter,sans-serif;color:#fff}
.bg{position:absolute;inset:-60px;background:url(data:${bgMime};base64,${bg}) center/cover;filter:blur(18px) saturate(1.15)}
.shade{position:absolute;inset:0;background:linear-gradient(160deg,rgba(5,10,30,.35) 0%,rgba(5,10,30,.72) 55%,rgba(3,6,20,.94) 100%)}
.wrap{position:absolute;inset:0;padding:84px 88px;display:flex;flex-direction:column}
.brand{font-weight:800;font-size:30px;letter-spacing:.32em}
.rule{width:96px;height:6px;border-radius:3px;background:#3b82f6;margin-top:22px}
.mid{margin-top:auto}
.kicker{font-weight:600;font-size:26px;letter-spacing:.14em;text-transform:uppercase;color:#93c5fd}
h1{font-weight:800;font-size:${name.length > 18 ? 86 : 104}px;line-height:1.02;letter-spacing:-.02em;margin-top:18px}
p{font-weight:400;font-size:34px;line-height:1.32;color:#dbe4f5;margin-top:28px;max-width:860px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.foot{margin-top:56px;display:flex;align-items:flex-end;justify-content:space-between}
.price{font-weight:800;font-size:76px;letter-spacing:-.02em}
.price small{display:block;font-weight:600;font-size:22px;letter-spacing:.12em;text-transform:uppercase;color:#93c5fd;margin-bottom:6px}
.url{font-weight:600;font-size:26px;color:#fff;background:rgba(59,130,246,.22);border:2px solid rgba(147,197,253,.55);padding:16px 24px;border-radius:999px}
</style></head><body>
<div class="bg"></div><div class="shade"></div>
<div class="wrap">
  <div><div class="brand">ZEVANORY</div><div class="rule"></div></div>
  <div class="mid">
    <div class="kicker">Produto 100% digital</div>
    <h1>${esc(name)}</h1>
    <p>${esc(headline(description))}</p>
  </div>
  <div class="foot">
    <div class="price"><small>Preço de tabela</small>R$ ${esc(price)}</div>
    <div class="url">vendas.zevanory.api.br/${esc(slug)}</div>
  </div>
</div></body></html>`;
}

const browser = await chromium.launch();
const results = [];
try {
  for (const [index, slug] of SLUGS.entries()) {
    const facts = await catalog(slug);
    const bgRes = await fetch(`${ORIGIN}/api/commercial/creative/background?product=${slug}&seed=${7300 + index}`, { method: 'POST', headers: factoryHeaders(), signal: AbortSignal.timeout(120_000) });
    if (!bgRes.ok) throw new Error('BACKGROUND_HTTP_' + bgRes.status + '_' + slug + '_' + (await bgRes.text()).slice(0, 300));
    const bgMime = bgRes.headers.get('content-type') || 'image/jpeg';
    const bg = Buffer.from(await bgRes.arrayBuffer()).toString('base64');
    const tab = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 1 });
    await tab.setContent(page({ ...facts, slug, bg, bgMime }), { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    const overflow = await tab.evaluate(() => document.querySelector('.wrap').scrollHeight > 1080);
    if (overflow) throw new Error('LAYOUT_OVERFLOW_' + slug);
    const jpeg = await tab.screenshot({ type: 'jpeg', quality: 90, clip: { x: 0, y: 0, width: 1080, height: 1080 } });
    await tab.close();
    fs.writeFileSync(path.join(out, slug + '.jpg'), jpeg);
    const sha = createHash('sha256').update(jpeg).digest('hex');
    const ts = String(Date.now()), nonce = randomUUID();
    const up = await fetch(`${ORIGIN}/api/commercial/creative/upload?product=${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-commercial-timestamp': ts, 'x-commercial-nonce': nonce, 'x-commercial-signature': sign(['zevanory-commercial-creative-upload-v1', ts, nonce, slug, sha]) },
      body: jpeg,
      signal: AbortSignal.timeout(60_000),
    });
    const raw = await up.text();
    console.log(`T2_UPLOAD ${slug} HTTP=${up.status} ${raw.slice(0, 400)}`);
    if (!up.ok) throw new Error('UPLOAD_HTTP_' + up.status + '_' + slug + '_' + raw.slice(0, 300));
    results.push(JSON.parse(raw));
  }
} finally {
  await browser.close();
}

const fin = await fetch(`${ORIGIN}/api/commercial/creative/factory/tick?finalize=1`, { method: 'POST', headers: factoryHeaders(), signal: AbortSignal.timeout(120_000) });
const finRaw = await fin.text();
console.log('T2_FINALIZE HTTP=' + fin.status + ' ' + finRaw.slice(0, 600));
if (!fin.ok) throw new Error('FINALIZE_HTTP_' + fin.status);
const final = JSON.parse(finRaw);
const composed = (final.creativeProof || []).filter((c) => (c.evidence || []).includes('composer:deterministic-typography-v1'));
if (final.approvals !== 5 || composed.length !== 5) throw new Error(`T2_APPROVALS_${final.approvals}_COMPOSED_${composed.length}`);
for (const c of composed) {
  const r = await fetch(c.imageUrl);
  const b = Buffer.from(await r.arrayBuffer());
  if (!r.ok || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('ASSET_UNREADABLE_' + c.imageUrl);
}
fs.writeFileSync(path.join(out, 'proof.json'), JSON.stringify({ uploads: results, final }, null, 2));
console.log('T2_RECORDS=' + JSON.stringify(composed.map((c) => ({ id: c.id, product: c.product, status: c.status, imageUrl: c.imageUrl }))));
console.log(`T2_CREATIVES=5/5_PASS ARCHIVED_BRIEFS=${final.archivedBriefs}`);
