import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PROJECT, normalizeWhatsappNumber, isOfficialWhatsapp } from '../src/config.mjs';

const root = process.cwd();
const units = [];
let blocked = false;
const t = (p) => readFileSync(join(root, p), 'utf8');

function op(name, fn) {
  try {
    const detail = fn();
    if (detail === false) throw new Error('condition_false');
    return { name, status: 'APPROVED', detail: String(detail ?? 'ok') };
  } catch (error) {
    blocked = true;
    return { name, status: 'FAILED', detail: String(error?.message || error) };
  }
}

function command(name, cmd, args, expect = 0) {
  return op(name, () => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: false });
    if (r.status !== expect) throw new Error(`exit=${r.status}; expected=${expect}`);
    return `exit=${r.status}`;
  });
}
function unit(id, label, operations) {
  const approved = operations.filter((x) => x.status === 'APPROVED').length;
  const status = approved >= 3 && operations.every((x) => x.status === 'APPROVED') ? 'APPROVED' : 'FAILED';
  if (status !== 'APPROVED') blocked = true;
  units.push({ id, label, approved_operations: approved, status, operations });
}

const fullTests = command('full test suite', process.execPath, ['--test',
  'test/telemetry.test.mjs','test/config.test.mjs','test/definitions.test.mjs',
  'test/landing.test.mjs','test/server-v2.integration.test.mjs','test/vercel.test.mjs','test/governance.test.mjs','test/publicEvent.test.mjs','test/asaas.test.mjs','test/asaas-webhook.test.mjs','test/order.test.mjs','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs','test/release.test.mjs','test/status.test.mjs']);

unit('CODE-CONFIG', 'src/config.mjs', [
  command('syntax config', process.execPath, ['--check','src/config.mjs']),
  command('config tests', process.execPath, ['--test','test/config.test.mjs']),
  op('canonical frozen definitions', () => Object.isFrozen(PROJECT) && PROJECT.name === 'ZEVANORY' && PROJECT.officialWhatsappE164 === '5588992340423'),
]);
unit('CODE-TELEMETRY', 'src/telemetry.mjs', [
  command('syntax telemetry', process.execPath, ['--check','src/telemetry.mjs']),
  command('telemetry tests', process.execPath, ['--test','test/telemetry.test.mjs']),
  op('financial boundary declared', () => t('src/telemetry.mjs').includes('payment_confirmed') && t('src/telemetry.mjs').includes('FINANCIAL_EVENTS')),
]);

unit('CODE-SERVER', 'src/server-v2.mjs', [
  command('syntax server', process.execPath, ['--check','src/server-v2.mjs']),
  command('server integration tests', process.execPath, ['--test','test/server-v2.integration.test.mjs']),
  op('fail-closed boundaries present', () => {
    const s = t('src/server-v2.mjs');
    return s.includes('payment_provider_not_configured') && s.includes('operator_auth_required') && s.includes('invalid_json');
  }),
]);

unit('CODE-LANDING', 'public/index.html', [
  command('landing tests', process.execPath, ['--test','test/landing.test.mjs']),
  op('institutional identity only', () => t('public/index.html').includes('<title>ZEVANORY</title>') && !t('public/index.html').includes('cta_whatsapp')),
  op('public domain identity', () => t('public/index.html').includes('zevanory.api.br') && !t('public/index.html').includes('Preço experimental')),
]);
unit('CODE-PILOT', 'public/piloto.html', [
  command('pilot tests', process.execPath, ['--test','test/piloto.test.mjs']),
  op('CTA disabled by default', () => t('public/piloto.html').includes('<button id="cta" disabled>')),
  op('telemetry before redirect', () => t('public/piloto.html').indexOf("await event('cta_whatsapp')") < t('public/piloto.html').indexOf("location.href = 'https://wa.me/'")),
]);
unit('CODE-AUDIT', 'scripts/audit-3x.mjs', [
  command('syntax audit', process.execPath, ['--check','scripts/audit-3x.mjs']),
  op('no external absolute reads', () => !/C:\\\\Sistemas\\\\(?!ZEVANORY)/i.test(t('scripts/audit-3x.mjs'))),
  op('three-operation fail-closed rule present', () => t('scripts/audit-3x.mjs').includes('approved >= 3') && t('scripts/audit-3x.mjs').includes("status !== 'APPROVED'")),
]);

unit('CODE-ASAAS','src/asaas.mjs',[
  command('syntax asaas',process.execPath,['--check','src/asaas.mjs']),
  command('asaas tests',process.execPath,['--test','test/asaas.test.mjs']),
  op('provider truth reconciliation required',()=>t('src/asaas.mjs').includes('paymentMatchesWebhook')&&t('src/asaas.mjs').includes('parseExternalReference')&&t('src/asaas.mjs').includes('PAYMENT_PARTIALLY_REFUNDED')&&t('src/asaas.mjs').includes('refundTotalForWebhook')),
]);
unit('CODE-ASAAS-WEBHOOK','api/webhooks/asaas.mjs',[
  command('syntax asaas webhook',process.execPath,['--check','api/webhooks/asaas.mjs']),
  command('asaas webhook tests',process.execPath,['--test','test/asaas-webhook.test.mjs']),
  op('webhook auth and API lookup fail closed',()=>t('api/webhooks/asaas.mjs').includes('asaas-access-token')&&t('api/webhooks/asaas.mjs').includes('fetchAsaasPayment')&&t('api/webhooks/asaas.mjs').includes('payment_reconciliation_failed')&&t('api/webhooks/asaas.mjs').includes('refunded_total')),
]);
unit('CODE-ORDER','src/order.mjs',[
  command('syntax order',process.execPath,['--check','src/order.mjs']),
  command('order tests',process.execPath,['--test','test/order.test.mjs']),
  op('order contract is canonical and sandbox-safe',()=>t('src/order.mjs').includes('ZEVANORY:${PROJECT.experimentId}')&&t('src/order.mjs').includes('sandbox\\.asaas\\.com\\/checkoutSession')),
]);
unit('CODE-ASAAS-CHECKOUT','api/checkout/asaas.mjs',[
  command('syntax asaas checkout',process.execPath,['--check','api/checkout/asaas.mjs']),
  command('asaas checkout tests',process.execPath,['--test','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs']),
  op('checkout kill switches and uncertain state are present',()=>t('api/checkout/asaas.mjs').includes('checkout_disabled')&&t('api/checkout/asaas.mjs').includes('checkout_sandbox_only')&&t('api/checkout/asaas.mjs').includes('checkout_uncertain')),
]);
unit('CODE-EVIDENCE-VERIFIER', 'scripts/verify_evidence_gate.ps1', [
  op('verifier exists', () => existsSync(join(root,'scripts','verify_evidence_gate.ps1'))),
  command('approved gate passes', 'powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/verify_evidence_gate.ps1','-GateFile','evidence/EG-0007-validacao-operacional-3x.md'], 0),
  command('template without approval blocks', 'powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/verify_evidence_gate.ps1','-GateFile','evidence/EVIDENCE_GATE_TEMPLATE.md'], 2),
]);

unit('RUNTIME-PACKAGE', 'package.json', [
  op('package JSON parses', () => Boolean(JSON.parse(t('package.json')).name)),
  op('start targets only server-v2', () => JSON.parse(t('package.json')).scripts.start.includes('server-v2.mjs') && !JSON.parse(t('package.json')).scripts.start.includes('src/server.mjs')),
  op('test and audit commands declared', () => Boolean(JSON.parse(t('package.json')).scripts.test) && Boolean(JSON.parse(t('package.json')).scripts['audit:3x'])),
]);
unit('DEF-OFFER', 'specs/OFFER-0001-ia-vendas-whatsapp.md', [
  op('offer evidence approved', () => t('evidence/EG-0004-g1b-oferta-ia-vendas-whatsapp.md').includes('Veredito: APROVADO')),
  fullTests,
  op('no unproven result promise', () => t('specs/OFFER-0001-ia-vendas-whatsapp.md').includes('Nao prometer aumento de vendas, faturamento, lucro ou conversao')),
]);

unit('DEF-PRICING', 'specs/PRICING-0001-preco-experimental.md', [
  op('pricing evidence approved', () => t('evidence/EG-0005-g1c-preco-disposicao-pagar.md').includes('Veredito: APROVADO')),
  fullTests,
  op('price explicitly experimental', () => t('specs/PRICING-0001-preco-experimental.md').includes('HIPOTESE PARA TESTE, NAO PRECO DEFINITIVO')),
]);

unit('DEF-EXPERIMENT', 'experiments/EXP-0001-oferta-piloto.md', [
  op('experiment evidence approved', () => t('evidence/EG-0006-g2-experimento-comercial-minimo.md').includes('Veredito: APROVADO')),
  fullTests,
  op('payment integrity defined', () => t('experiments/EXP-0001-oferta-piloto.md').includes('payment_confirmed so pode vir de provedor autenticado')),
]);
unit('DEF-EVIDENCE-POLICY', 'specs/EVIDENCE_POLICY.md', [
  op('requires three independent evidences', () => t('specs/EVIDENCE_POLICY.md').includes('Pelo menos 3 evidencias validas e independentes')),
  op('base evidence gate approved', () => t('evidence/EG-0001-evidence-policy.md').includes('Veredito: APROVADO')),
  op('operational 3x gate approved', () => t('evidence/EG-0007-validacao-operacional-3x.md').includes('Veredito: APROVADO')),
]);

unit('DEF-GATES', 'specs/GATES.md', [
  op('market and offer gates defined', () => t('specs/GATES.md').includes('G0 Mercado') && t('specs/GATES.md').includes('G1 Oferta')),
  op('commercial proof gate defined', () => t('specs/GATES.md').includes('G2 Venda manual')),
  op('autonomy remains final gated stage', () => t('specs/GATES.md').includes('G12 Autonomia')),
]);

unit('DEF-WHATSAPP', 'evidence/WHATSAPP-ORIGIN-0001.md', [
  op('owner-confirmed canonical number documented', () => t('evidence/WHATSAPP-ORIGIN-0001.md').includes('5588992340423') && t('evidence/WHATSAPP-ORIGIN-0001.md').includes('confirmou explicitamente')),
  op('canonical definition matches normalizer', () => PROJECT.officialWhatsappE164 === '5588992340423' && normalizeWhatsappNumber('+55 88 99234-0423') === '5588992340423'),
  op('official matcher rejects divergence', () => isOfficialWhatsapp('5588992340423') && !isOfficialWhatsapp('5588999999999')),
]);
unit('DEF-SCOPE', 'specs/SCOPE_BOUNDARY.md', [
  op('project root is explicit', () => t('specs/SCOPE_BOUNDARY.md').includes('C:\\Sistemas\\ZEVANORY')),
  op('external systems explicitly out of scope', () => t('specs/SCOPE_BOUNDARY.md').includes('fora de escopo')),
  op('external absolute paths forbidden', () => t('specs/SCOPE_BOUNDARY.md').includes('caminho absoluto para outro sistema')),
]);

const testFiles=['test/telemetry.test.mjs','test/config.test.mjs','test/definitions.test.mjs','test/landing.test.mjs','test/server-v2.integration.test.mjs','test/vercel.test.mjs','test/governance.test.mjs','test/publicEvent.test.mjs','test/asaas.test.mjs','test/asaas-webhook.test.mjs','test/order.test.mjs','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs','test/release.test.mjs','test/status.test.mjs'];
unit('ASSURANCE-TESTS','test harness',[
  op('all test files exist',()=>testFiles.every((f)=>existsSync(join(root,f)))),
  op('all test files syntax-valid',()=>testFiles.every((f)=>spawnSync(process.execPath,['--check',f],{cwd:root,encoding:'utf8'}).status===0)),
  fullTests,
]);

unit('CODE-OPERATIONAL-STATUS','src/operationalStatus.mjs + api/status.mjs',[
  command('operational status syntax',process.execPath,['--check','src/operationalStatus.mjs']),
  command('operational status tests',process.execPath,['--test','test/status.test.mjs']),
  op('status exposes aggregates without PII',()=>t('api/status.mjs').includes('count(*)::int as count')&&!t('api/status.mjs').includes('session_id')&&!t('api/status.mjs').includes('provider_payment_id')),
]);
unit('CODE-VERCEL-API-CONFIG','api/config.mjs',[
  command('syntax vercel config api',process.execPath,['--check','api/config.mjs']),
  command('vercel tests',process.execPath,['--test','test/vercel.test.mjs']),
  op('production config remains fail-closed',()=>t('api/config.mjs').includes('whatsapp_enabled: true')&&t('api/config.mjs').includes('telemetry-active-payment-pending')),
]);
unit('CODE-VERCEL-API-EVENT','api/events-public.mjs',[
  command('syntax vercel event api',process.execPath,['--check','api/events-public.mjs']),
  command('vercel event tests',process.execPath,['--test','test/vercel.test.mjs']),
  op('Neon persistence is idempotent and fail-closed',()=>t('api/events-public.mjs').includes('ON CONFLICT (event_id) DO NOTHING')&&t('api/events-public.mjs').includes('telemetry_storage_unavailable')),
]);
unit('CODE-PUBLIC-EVENT','src/publicEvent.mjs',[
  command('syntax public event',process.execPath,['--check','src/publicEvent.mjs']),
  command('public event tests',process.execPath,['--test','test/publicEvent.test.mjs']),
  op('public boundary rejects financial event',()=>t('src/publicEvent.mjs').includes('PUBLIC_EVENTS')&&t('test/publicEvent.test.mjs').includes('payment_confirmed')),
]);
unit('DEF-NEON-PERSISTENCE','evidence/EG-0011-g3-neon-persistencia.md',[
  op('Neon gate exists',()=>t('evidence/EG-0011-g3-neon-persistencia.md').includes('Neon Serverless Postgres')),
  op('Supabase explicitly forbidden',()=>t('evidence/EG-0011-g3-neon-persistencia.md').includes('Supabase: PROIBIDO')),
  command('Neon-related tests',process.execPath,['--test','test/publicEvent.test.mjs','test/vercel.test.mjs']),
]);
unit('DEF-DB-MIGRATION','db/migrations/001_telemetry_events.sql',[
  op('primary key idempotency defined',()=>t('db/migrations/001_telemetry_events.sql').includes('event_id uuid PRIMARY KEY')),
  op('financial event names constrained',()=>t('db/migrations/001_telemetry_events.sql').includes('payment_confirmed')&&t('db/migrations/001_telemetry_events.sql').includes('refund_confirmed')),
  op('migration ledger defined',()=>t('db/migrations/001_telemetry_events.sql').includes('schema_migrations')&&t('db/migrations/001_telemetry_events.sql').includes('001_telemetry_events')),
]);
unit('DEF-FINANCIAL-MIGRATION','db/migrations/002_financial_events.sql',[
  op('provider event id is primary key',()=>t('db/migrations/002_financial_events.sql').includes('provider_event_id text PRIMARY KEY')),
  op('payment state dedup index exists',()=>t('db/migrations/002_financial_events.sql').includes('financial_events_payment_state_idx')),
  op('migration ledger 002 exists',()=>t('db/migrations/002_financial_events.sql').includes('schema_migrations')&&t('db/migrations/002_financial_events.sql').includes('002_financial_events')&&t('db/migrations/002_financial_events.sql').includes('COMMIT;')),
]);
unit('DEF-PAYMENT-PROVIDER','evidence/EG-0013-provedor-pagamento-asaas.md',[
  op('payment provider evidence gate approved',()=>t('evidence/EG-0013-provedor-pagamento-asaas.md').includes('Veredito: APROVADO')),
  command('payment provider tests',process.execPath,['--test','test/asaas.test.mjs','test/asaas-webhook.test.mjs']),
  op('browser callback never becomes financial truth',()=>t('evidence/EG-0013-provedor-pagamento-asaas.md').includes('nunca confirma sozinho')&&t('evidence/EG-0013-provedor-pagamento-asaas.md').includes('reconciliar pela API')),
]);
unit('DEF-PARTIAL-REFUND-MIGRATION','db/migrations/004_partial_refund_snapshots.sql',[
  op('refund cumulative column exists',()=>t('db/migrations/004_partial_refund_snapshots.sql').includes('refunded_total numeric(12,2)')),
  op('payment and refund dedup indexes are separated',()=>t('db/migrations/004_partial_refund_snapshots.sql').includes('financial_events_payment_confirmed_idx')&&t('db/migrations/004_partial_refund_snapshots.sql').includes('financial_events_refund_snapshot_idx')),
  op('migration 004 is ledgered and transactional',()=>t('db/migrations/004_partial_refund_snapshots.sql').includes('004_partial_refund_snapshots')&&t('db/migrations/004_partial_refund_snapshots.sql').includes('COMMIT;')),
]);
unit('DEF-PARTIAL-REFUND-GATE','evidence/EG-0016-estorno-parcial.md',[
  op('partial refund evidence gate approved',()=>t('evidence/EG-0016-estorno-parcial.md').includes('Veredito: APROVADO')),
  command('partial refund tests',process.execPath,['--test','test/asaas.test.mjs','test/asaas-webhook.test.mjs']),
  op('DONE-only cumulative reconciliation documented',()=>t('evidence/EG-0016-estorno-parcial.md').includes('snapshots cumulativos')&&t('evidence/EG-0016-estorno-parcial.md').includes('DONE')),
]);
unit('DEF-ORDERS-MIGRATION','db/migrations/003_orders_checkout.sql',[
  op('request id uniqueness defined',()=>t('db/migrations/003_orders_checkout.sql').includes('request_id uuid NOT NULL UNIQUE')),
  op('financial events link to internal order',()=>t('db/migrations/003_orders_checkout.sql').includes('order_id uuid REFERENCES orders(order_id)')),
  op('migration ledger 003 exists',()=>t('db/migrations/003_orders_checkout.sql').includes('003_orders_checkout')&&t('db/migrations/003_orders_checkout.sql').includes('COMMIT;')),
]);
unit('DEF-CHECKOUT-GATE','evidence/EG-0014-pedido-checkout.md',[
  op('checkout evidence gate approved',()=>t('evidence/EG-0014-pedido-checkout.md').includes('Veredito: APROVADO')),
  command('checkout gate tests',process.execPath,['--test','test/order.test.mjs','test/checkout-asaas.test.mjs']),
  op('checkout never proves payment',()=>t('evidence/EG-0014-pedido-checkout.md').includes('Nenhuma fonte autoriza tratar redirect/sucesso de checkout como pagamento confirmado')),
]);
unit('DEF-VERCEL-CONFIG','vercel.json',[
  op('vercel json parses',()=>Boolean(JSON.parse(t('vercel.json')).rewrites)),
  command('vercel tests validate routing',process.execPath,['--test','test/vercel.test.mjs']),
  op('root and events rewrites defined',()=>t('vercel.json').includes('/public/index.html')&&t('vercel.json').includes('/api/events/public')),
]);
unit('DEF-DEPLOY-SERIALIZATION','evidence/EG-0015-deploy-serializado.md',[
  op('deploy serialization gate approved',()=>t('evidence/EG-0015-deploy-serializado.md').includes('Veredito: APROVADO')),
  op('workstreams requires full serialized deploy',()=>t('WORKSTREAMS.md').includes('Deploy de producao e operacao serializada')&&t('WORKSTREAMS.md').includes('pacote completo')),
  op('agent requires alias identity verification',()=>t('AGENTS.md').includes('alias publico continuar apontando para o deployment exato promovido')),
]);
unit('CODE-RELEASE-FINGERPRINT','src/release.mjs + api/release.mjs',[
  command('release tests',process.execPath,['--test','test/release.test.mjs']),
  command('release endpoint syntax',process.execPath,['--check','api/release.mjs']),
  op('release manifest is immutable and complete',()=>t('src/release.mjs').includes('ZEVANORY-EG0014-RC1')&&t('src/release.mjs').includes('/api/checkout/asaas')&&t('src/release.mjs').includes('/api/webhooks/asaas')&&t('src/release.mjs').includes('/api/release')),
]);
unit('DEF-DEPLOY-SAFETY','evidence/EG-0008-deploy-zevanory-vercel.md',[
  op('deploy evidence gate approved',()=>t('evidence/EG-0008-deploy-zevanory-vercel.md').includes('Veredito: APROVADO')),
  fullTests,
  op('production kill-switch documented',()=>t('evidence/EG-0008-deploy-zevanory-vercel.md').includes('manter CTA comercial bloqueado')),
]);
unit('DEF-CANONICAL-MASTER','ZEVANORY_MASTER.md',[
  op('master exists',()=>existsSync(join(root,'ZEVANORY_MASTER.md'))),
  command('governance tests',process.execPath,['--test','test/governance.test.mjs']),
  op('master has trajectory and current state',()=>t('ZEVANORY_MASTER.md').includes('TRAJETO APROVADO')&&t('ZEVANORY_MASTER.md').includes('ESTADO ATUAL')&&t('ZEVANORY_MASTER.md').includes('PROXIMOS PASSOS AUTORIZADOS')),
]);
unit('DEF-GOVERNANCE','evidence/EG-0009-governanca-trajeto-zevanory.md',[
  op('governance evidence approved',()=>t('evidence/EG-0009-governanca-trajeto-zevanory.md').includes('Veredito: APROVADO')),
  command('governance test suite',process.execPath,['--test','test/governance.test.mjs']),
  op('fail-closed continuation declared',()=>t('evidence/EG-0009-governanca-trajeto-zevanory.md').includes('fica BLOQUEADA')),
]);
unit('DEF-AGENT-ENTRYPOINT','AGENTS.md',[
  op('agent entrypoint exists',()=>existsSync(join(root,'AGENTS.md'))),
  command('governance tests include entrypoint',process.execPath,['--test','test/governance.test.mjs']),
  op('entrypoint requires master and gates',()=>t('AGENTS.md').includes('Leia ZEVANORY_MASTER.md inteiro')&&t('AGENTS.md').includes('Nao pule gates')&&t('AGENTS.md').includes('Qualquer divergencia bloqueia a acao')),
]);
unit('PROJECT-HYGIENE','project-only hygiene',[
  op('legacy server absent',()=>!existsSync(join(root,'src','server.mjs'))),
  op('old WhatsApp absent from active files',()=>!['src/config.mjs','src/server-v2.mjs','public/index.html','test/config.test.mjs','test/server-v2.integration.test.mjs','evidence/WHATSAPP-ORIGIN-0001.md'].some((f)=>t(f).includes('5588921928688'))),
  op('audit has no external absolute reads',()=>!t('scripts/audit-3x.mjs').includes('readFileSync(' + String.fromCharCode(39) + 'C:')) ,
]);

const report={policy:'minimum 3 approved operations per audited code/definition unit',scope:'ZEVANORY only',units,totals:{units:units.length,approved:units.filter(x=>x.status==='APPROVED').length,failed:units.filter(x=>x.status!=='APPROVED').length},verdict:blocked?'BLOCKED':'APPROVED'};
writeFileSync(join(root,'validation','AUDIT-3X-CURRENT.json'),JSON.stringify(report,null,2)+'\n','utf8');
for(const item of units) console.log(`${item.status} ${item.id} operations=${item.approved_operations}`);
console.log(`AUDIT_3X_${report.verdict} units=${report.totals.units} approved=${report.totals.approved} failed=${report.totals.failed}`);
process.exit(blocked?1:0);
