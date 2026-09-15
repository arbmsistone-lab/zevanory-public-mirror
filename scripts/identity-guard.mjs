import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const testFile = await readFile(new URL('../test/landing.test.mjs', import.meta.url), 'utf8');
const brandTest = await readFile(new URL('../test/brand-identity.test.mjs', import.meta.url), 'utf8');

const forbiddenPublic = [
  /GIRO LOCAL/i,
  /girolocal\.api\.br/i,
  /Falar sobre o piloto no WhatsApp/i,
  /Preço experimental/i,
  /config\.offer_id/,
  /cta_whatsapp/,
];

let failed = false;
for (const pattern of forbiddenPublic) {
  if (pattern.test(html)) {
    console.error('IDENTITY_GUARD_FAIL public/index.html ' + pattern);
    failed = true;
  }
}

const required = [/<title>ZEVANORY(?:\s*\|[^<]*)?<\/title>/, /zevanory\.api\.br/i, /Centro executivo\s*·\s*Operação em tempo real/i, /doesNotMatch/, /\/brand\/zevanory-logo-dark\.svg/, /\/brand\/favicon\.svg/];
for (const pattern of required) {
  const source = String(pattern).includes('doesNotMatch') ? testFile : html;
  if (!pattern.test(source)) {
    console.error('IDENTITY_GUARD_FAIL required ' + pattern);
    failed = true;
  }
}
if (!/official brand assets exist locally/.test(brandTest)) { console.error('IDENTITY_GUARD_FAIL brand contract missing'); failed=true; }
if (failed) process.exit(1);
console.log('IDENTITY_GUARD_PASS');