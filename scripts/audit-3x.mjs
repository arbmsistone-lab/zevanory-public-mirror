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
  'test/landing.test.mjs','test/server-v2.integration.test.mjs','test/vercel.test.mjs','test/governance.test.mjs','test/publicEvent.test.mjs','test/asaas.test.mjs','test/asaas-webhook.test.mjs','test/order.test.mjs','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs','test/release.test.mjs','test/status.test.mjs','test/sales-gate.test.mjs','test/order-financial-state.test.mjs','test/pre-sale-readiness.test.mjs','test/precommerce.test.mjs','test/checkout-production.test.mjs']);

unit('CODE-CONFIG', 'src/config.mjs', [
  command('syntax config', process.execPath, ['--check','src/config.mjs']),
  command('config tests', process.execPath, ['--test','test/config.test.mjs']),
  op('canonical frozen definitions', () => Object.isFrozen(PROJECT) && PROJECT.name === 'ZEVANORY' && PROJECT.officialWhatsappE164 === '5588992340423'),
]);
unit('CODE-SALES-GATE','src/salesGate.mjs',[
  command('sales gate syntax',process.execPath,['--check','src/salesGate.mjs']),
  command('sales gate tests',process.execPath,['--test','test/sales-gate.test.mjs']),
  op('three-layer fail-closed global gate',()=>t('src/salesGate.mjs').includes('SALE_GLOBALLY_ENABLED')&&t('src/salesGate.mjs').includes('PRE_SALE_GATES_APPROVED')&&t('src/salesGate.mjs').includes('globalEnabled && preSaleApproved && manifest.approved')),
]);
unit('CODE-PRE-SALE-APPROVAL','src/preSaleApproval.mjs',[
  command('pre-sale approval syntax',process.execPath,['--check','src/preSaleApproval.mjs']),
  op('manifest derives approval from activation readiness',()=>t('src/preSaleApproval.mjs').includes('evaluateActivationReadiness')&&t('src/preSaleApproval.mjs').includes("custom_domain:'EG-0021'")),
  op('sandbox homologation is evidenced without approving sales',()=>!t('src/preSaleApproval.mjs').includes('asaas_sandbox_unconfigured')&&t('src/preSaleApproval.mjs').includes("provider_sandbox_e2e:'EG-0026'")&&t('src/preSaleApproval.mjs').includes("global_sales_gate:'EG-0018'")),
]);
unit('CODE-PRE-SALE-READINESS','src/preSaleReadiness.mjs + scripts/pre-sale-preflight.mjs',[
  command('pre-sale readiness syntax',process.execPath,['--check','src/preSaleReadiness.mjs']),
  command('pre-sale readiness tests',process.execPath,['--test','test/pre-sale-readiness.test.mjs']),
  op('three resolver, sandbox dependency and kill-switch checks',()=>{
    const readiness=t('src/preSaleReadiness.mjs');
    const preflight=t('scripts/pre-sale-preflight.mjs');
    return readiness.includes('1.1.1.1') && readiness.includes('8.8.8.8') &&
      readiness.includes('9.9.9.9') && readiness.includes('https_ready') &&
      readiness.includes('routes_ready') && readiness.includes('database_url') &&
      readiness.includes('public_base_https') && readiness.includes('financial_events_enabled') &&
      readiness.includes('commercial_flags_safe') && preflight.includes('DATABASE_URL') &&
      preflight.includes('FINANCIAL_EVENTS_ENABLED') && !preflight.includes('console.log(process.env)');
  }),
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
  op('public domain identity', () => t('public/index.html').includes('zevanory.api.br') && !t('public/index.html').includes('Pre\u00e7o experimental')),
]);
unit('CODE-PILOT', 'public/piloto.html', [
  command('pilot tests', process.execPath, ['--test','test/piloto.test.mjs']),
  op('CTA disabled by default', () => t('public/piloto.html').includes('<button id="cta" disabled>')),
  op('telemetry before redirect', () => t('public/piloto.js').indexOf("await event('cta_whatsapp')") < t('public/piloto.js').indexOf("location.href = 'https://wa.me/'")),
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
unit('CODE-ASAAS-WEBHOOK','src/http/webhookAsaas.mjs',[
  command('syntax asaas webhook',process.execPath,['--check','src/http/webhookAsaas.mjs']),
  command('asaas webhook tests',process.execPath,['--test','test/asaas-webhook.test.mjs']),
  op('webhook auth and API lookup fail closed',()=>t('src/http/webhookAsaas.mjs').includes('asaas-access-token')&&t('src/http/webhookAsaas.mjs').includes('fetchAsaasPayment')&&t('src/http/webhookAsaas.mjs').includes('payment_reconciliation_failed')&&t('src/http/webhookAsaas.mjs').includes('refunded_total')),
]);
unit('CODE-ORDER','src/order.mjs',[
  command('syntax order',process.execPath,['--check','src/order.mjs']),
  command('order tests',process.execPath,['--test','test/order.test.mjs']),
  op('order contract supports explicit Asaas environments safely',()=>t('src/order.mjs').includes('ZEVANORY:${PROJECT.experimentId}')&&t('src/order.mjs').includes('checkoutUrlForId')&&t('src/order.mjs').includes('normalizeAsaasCheckoutResponse')&&t('src/order.mjs').includes('https://asaas.com/checkoutSession/show?id=')),
]);
unit('CODE-ASAAS-CHECKOUT','src/http/checkoutAsaas.mjs',[
  command('syntax asaas checkout',process.execPath,['--check','src/http/checkoutAsaas.mjs']),
  command('asaas checkout tests',process.execPath,['--test','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs']),
  op('checkout kill switches and uncertain state are present',()=>t('src/http/checkoutAsaas.mjs').includes('sales_globally_blocked')&&t('src/http/checkoutAsaas.mjs').includes('checkout_disabled')&&t('src/http/checkoutAsaas.mjs').includes('checkout_environment_invalid')&&t('src/http/checkoutAsaas.mjs').includes("['sandbox','production']")&&t('src/http/checkoutAsaas.mjs').includes('checkout_uncertain')),
]);
unit('CODE-EVIDENCE-VERIFIER', 'scripts/verify_evidence_gate.ps1', [
  op('verifier exists', () => existsSync(join(root,'scripts','verify_evidence_gate.ps1'))),
  command('approved gate passes', process.execPath, ['scripts/verify-evidence-gate.mjs','evidence/EG-0007-validacao-operacional-3x.md'], 0),
  command('template without approval blocks', process.execPath, ['scripts/verify-evidence-gate.mjs','evidence/EVIDENCE_GATE_TEMPLATE.md'], 2),
]);

unit('RUNTIME-PACKAGE', 'package.json', [
  op('package JSON parses', () => Boolean(JSON.parse(t('package.json')).name)),
  op('start targets only server-v2', () => JSON.parse(t('package.json')).scripts.start.includes('server-v2.mjs') && !JSON.parse(t('package.json')).scripts.start.includes('src/server.mjs')),
  op('test audit and pre-sale preflight commands declared', () => {
    const scripts=JSON.parse(t('package.json')).scripts;
    return Boolean(scripts.test) && Boolean(scripts['audit:3x']) && Boolean(scripts['preflight:pre-sale']);
  }),
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

const testFiles=['test/telemetry.test.mjs','test/config.test.mjs','test/definitions.test.mjs','test/landing.test.mjs','test/server-v2.integration.test.mjs','test/vercel.test.mjs','test/governance.test.mjs','test/publicEvent.test.mjs','test/asaas.test.mjs','test/asaas-webhook.test.mjs','test/order.test.mjs','test/checkout-asaas.test.mjs','test/checkout-persist-safety.test.mjs','test/release.test.mjs','test/status.test.mjs','test/sales-gate.test.mjs','test/order-financial-state.test.mjs','test/pre-sale-readiness.test.mjs','test/precommerce.test.mjs','test/checkout-production.test.mjs'];
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
  op('production config remains globally fail-closed',()=>t('api/config.mjs').includes('commercial_enabled: gate.enabled')&&t('api/config.mjs').includes('whatsapp_enabled: whatsappEnabled')&&t('api/config.mjs').includes("'pre-sale-blocked'")),
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
unit('CODE-PAYMENT-PROVIDER-ABSTRACTION','src/paymentProviders.mjs + db/migrations/010_payment_provider_abstraction.sql',[
  command('payment abstraction tests',process.execPath,['--test','test/mercadopago.test.mjs','test/pre-sale-readiness.test.mjs']),
  op('migration 010 permits both providers',()=>{const m=t('db/migrations/010_payment_provider_abstraction.sql');return m.includes("'asaas'")&&m.includes("'mercadopago'")&&m.includes('010_payment_provider_abstraction');}),
  op('provider selector remains fail closed',()=>{const p=t('src/paymentProviders.mjs');return p.includes('payment_provider_not_selected')&&p.includes('asaas_credentials_missing')&&p.includes('mercadopago_credentials_missing');}),
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
unit('DEF-ORDER-FINANCIAL-STATE','evidence/EG-0017-estado-transacional-pedido.md',[
  op('order financial state gate approved',()=>t('evidence/EG-0017-estado-transacional-pedido.md').includes('Veredito: APROVADO')),
  command('order financial state tests',process.execPath,['--test','test/order-financial-state.test.mjs']),
  op('webhook transition is atomic',()=>t('src/http/webhookAsaas.mjs').includes('WITH target AS')&&t('src/http/webhookAsaas.mjs').includes('inserted AS')&&t('src/http/webhookAsaas.mjs').includes('updated AS')),
]);
unit('DEF-ORDER-FINANCIAL-MIGRATION','db/migrations/005_order_financial_states.sql',[
  op('partial refund order state is allowed',()=>t('db/migrations/005_order_financial_states.sql').includes("'partially_refunded'")),
  op('orders status constraint is recreated',()=>t('db/migrations/005_order_financial_states.sql').includes('orders_status_check')&&t('db/migrations/005_order_financial_states.sql').includes('CHECK (status IN')),
  op('migration 005 is ledgered',()=>t('db/migrations/005_order_financial_states.sql').includes('005_order_financial_states')&&t('db/migrations/005_order_financial_states.sql').includes('COMMIT;')),
]);
unit('DEF-SALES-GATE-EVIDENCE','evidence/EG-0018-bloqueio-global-pre-venda.md',[
  op('global sales gate evidence approved',()=>t('evidence/EG-0018-bloqueio-global-pre-venda.md').includes('Veredito: APROVADO')),
  command('global sales gate tests',process.execPath,['--test','test/sales-gate.test.mjs','test/checkout-asaas.test.mjs']),
  op('global gate is fail closed',()=>t('evidence/EG-0018-bloqueio-global-pre-venda.md').includes('SALE_GLOBALLY_ENABLED=false')&&t('evidence/EG-0018-bloqueio-global-pre-venda.md').includes('qualquer gate aberto')),
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
unit('CODE-SECURITY','src/security.mjs + vercel.json',[
  command('security syntax',process.execPath,['--check','src/security.mjs']),
  command('security tests',process.execPath,['--test','test/security.test.mjs','test/vercel.test.mjs','test/landing.test.mjs','test/piloto.test.mjs']),
  op('security boundaries are fail-closed',()=>t('src/security.mjs').includes('timingSafeEqual')&&t('src/security.mjs').includes('origin_not_allowed')&&t('api/events-public.mjs').includes('rate_limited')&&t('vercel.json').includes('Content-Security-Policy'))
]);
unit('CODE-RELEASE-FINGERPRINT','src/release.mjs + api/release.mjs',[
  command('release tests',process.execPath,['--test','test/release.test.mjs']),
  command('release endpoint syntax',process.execPath,['--check','api/release.mjs']),
  op('release manifest is immutable and complete',()=>t('src/release.mjs').includes('ZEVANORY-EG0039-FINAL')&&t('src/release.mjs').includes("salesMode: 'globally-blocked'")&&t('src/release.mjs').includes('/api/checkout/asaas')&&t('src/release.mjs').includes('/api/webhooks/asaas')&&t('src/release.mjs').includes('/api/release')),
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
unit('CODE-COMPOSABLE-ARCHITECTURE','src/composableArchitecture.mjs',[
  command('composable architecture syntax',process.execPath,['--check','src/composableArchitecture.mjs']),
  command('composable architecture tests',process.execPath,['--test','test/composable-infrastructure.test.mjs']),
  op('architecture is acyclic modular and cost disciplined',()=>t('src/composableArchitecture.mjs').includes('modular-monolith-ports-adapters-transactional-outbox')&&t('src/composableArchitecture.mjs').includes('distributedMicroservicesRequired: false')&&t('src/composableArchitecture.mjs').includes('paidInfrastructureRequired: false')),
]);
unit('CODE-INTEGRATION-OUTBOX','src/integrationOutbox.mjs + db/migrations/009_composable_infrastructure.sql',[
  command('integration outbox syntax',process.execPath,['--check','src/integrationOutbox.mjs']),
  command('integration outbox tests',process.execPath,['--test','test/composable-infrastructure.test.mjs']),
  op('outbox is idempotent concurrent and dead-lettered',()=>t('db/migrations/009_composable_infrastructure.sql').includes('idempotency_key text NOT NULL UNIQUE')&&t('src/integrationOutbox.mjs').includes('for update skip locked')&&t('src/integrationOutbox.mjs').includes("'dead_letter'")),
]);
unit('DEF-COMPOSABLE-EVIDENCE','evidence/EG-0036-composable-commerce-infrastructure-benchmark.md',[
  op('five professional benchmarks recorded',()=>['Shopify','commercetools','Salesforce','Adobe','BigCommerce'].every(x=>t('evidence/EG-0036-composable-commerce-infrastructure-benchmark.md').includes(x))),
  command('composable 10x audit',process.execPath,['scripts/audit-composable-10x.mjs']),
  op('sales remain blocked by decision',()=>t('evidence/EG-0036-composable-commerce-infrastructure-benchmark.md').includes('nao autoriza vendas')),
]);unit('CODE-ENTERPRISE-ASSURANCE','src/enterpriseAssurance.mjs + api/assurance.mjs',[
  command('enterprise assurance syntax',process.execPath,['--check','src/enterpriseAssurance.mjs']),
  command('enterprise assurance tests',process.execPath,['--test','test/enterprise-assurance.test.mjs']),
  op('SLO truth and outbox health are explicit',()=>t('src/enterpriseAssurance.mjs').includes('historical_slo_proven:false')&&t('src/enterpriseAssurance.mjs').includes('assessOutboxHealth')),
]);
unit('DEF-ENTERPRISE-SLO','specs/SLO_POLICY.md',[
  op('SLO policy exists',()=>existsSync(join(root,'specs','SLO_POLICY.md'))),
  command('enterprise 10x audit',process.execPath,['scripts/audit-enterprise-10x.mjs']),
  op('commercial gates remain out of scope',()=>t('specs/SLO_POLICY.md').includes('NAO HISTORICO COMPROVADO')),
]);
unit('CODE-ACTIVATION-PLAN','src/activationPlan.mjs + api/config.mjs',[
  command('activation plan syntax',process.execPath,['--check','src/activationPlan.mjs']),
  command('activation readiness tests',process.execPath,['--test','test/activation-ready.test.mjs']),
  op('cutover and rollback remain fail closed',()=>t('src/activationPlan.mjs').includes('SALE_GLOBALLY_ENABLED=false')&&t('src/activationPlan.mjs').includes('verify_fail_closed')),
]);
unit('DEF-ACTIVATION-READINESS','evidence/EG-0038-commercial-activation-readiness.md',[
  op('activation evidence exists',()=>existsSync(join(root,'evidence','EG-0038-commercial-activation-readiness.md'))),
  command('activation 20x audit',process.execPath,['scripts/audit-activation-20x.mjs']),
  op('external inputs are never fabricated',()=>t('evidence/EG-0038-commercial-activation-readiness.md').includes('nao fabricar')),
]);
unit('CODE-OFFICIAL-BRAND','public/brand + public surfaces',[
  command('brand identity tests',process.execPath,['--test','test/brand-identity.test.mjs','test/landing.test.mjs']),
  command('identity guard',process.execPath,['scripts/identity-guard.mjs']),
  op('official brand is self hosted and required',()=>t('public/index.html').includes('/brand/zevanory-logo-dark.svg')&&t('public/index.html').includes('/brand/favicon.svg')&&t('src/release.mjs').includes("official_brand:'approved'")),
]);
unit('CODE-LOCAL-STATIC-PARITY','src/server-v2.mjs',[
  command('local server syntax',process.execPath,['--check','src/server-v2.mjs']),
  command('local static integration tests',process.execPath,['--test','test/server-v2.integration.test.mjs']),
  op('local server restricts public root with MIME and nosniff',()=>t('src/server-v2.mjs').includes('resolve(publicDir')&&t('src/server-v2.mjs').includes("'x-content-type-options':'nosniff'")&&t('src/server-v2.mjs').includes("'.svg':'image/svg+xml; charset=utf-8'")),
]);
unit('DEF-OFFICIAL-BRAND-EVIDENCE','evidence/EG-0040-official-brand-local-parity.md',[
  op('brand evidence gate approved',()=>t('evidence/EG-0040-official-brand-local-parity.md').includes('Status: APROVADO')),
  command('rules 20x audit',process.execPath,['scripts/audit-rules-20x.mjs']),
  op('evidence records OWASP MDN and Vercel',()=>['OWASP','MDN','Vercel'].every(x=>t('evidence/EG-0040-official-brand-local-parity.md').includes(x))),
]);
unit('CODE-WORLDCLASS-DASHBOARD','public/index.html + public/index.css + public/index.js',[
  command('worldclass dashboard tests',process.execPath,['--test','test/worldclass-dashboard.test.mjs']),
  command('worldclass dashboard 10x audit',process.execPath,['scripts/audit-worldclass-dashboard-10x.mjs']),
  op('single screen plus progressive detail semantics',()=>t('public/index.css').includes('EG-0046 — progressive executive disclosure')&&t('public/index.css').includes('data-enabled="false"] b{color:var(--amber)')&&t('public/index.css').includes('.dialog-shell{height:100%;overflow:auto')),
]);
unit('DEF-WORLDCLASS-DASHBOARD-EVIDENCE','evidence/EG-0041-worldclass-executive-dashboard.md',[
  op('three independent design references recorded',()=>['AWS Cloudscape','IBM Carbon','Atlassian Design System'].every(x=>t('evidence/EG-0041-worldclass-executive-dashboard.md').includes(x))),
  op('commercial truth remains invariant',()=>t('evidence/EG-0041-worldclass-executive-dashboard.md').includes('nenhum switch pode ser visualmente ON')&&t('evidence/EG-0041-worldclass-executive-dashboard.md').includes('fail-closed')),
  command('identity guard',process.execPath,['scripts/identity-guard.mjs']),
]);
unit('CODE-VISUAL-CERTIFICATION','public/index.css + public/index.js',[
  command('visual certification tests',process.execPath,['--test','test/visual-certification.test.mjs']),
  command('visual certification 10x audit',process.execPath,['scripts/audit-visual-certification-10x.mjs']),
  op('progressive visual system preserves evidence at readable density',()=>t('public/index.css').includes('EG-0046 — progressive executive disclosure')&&t('public/index.html').includes('id="details-dialog"')&&t('public/index.js').includes('showModal()')),
]);
unit('DEF-VISUAL-CERTIFICATION-EVIDENCE','evidence/EG-0046-progressive-executive-disclosure.md',[
  op('visual certification evidence recorded',()=>t('evidence/EG-0046-progressive-executive-disclosure.md').includes('Status: APPROVED')),
  op('acceptance criteria records progressive readable integrity',()=>['1280x720','11 px','1600x900','12 px','Dialog'].every(x=>t('evidence/EG-0046-progressive-executive-disclosure.md').includes(x))),
  command('identity guard',process.execPath,['scripts/identity-guard.mjs']),
]);
unit('CODE-OUTBOUND-ADAPTERS','src/outboundAdapters.mjs + src/integrationOutbox.mjs + api/agent-run.mjs',[
  command('outbound adapters syntax',process.execPath,['--check','src/outboundAdapters.mjs']),
  command('outbound adapters tests',process.execPath,['--test','test/outbound-adapters.test.mjs']),
  op('channel dispatcher excludes payment destinations',()=>t('src/integrationOutbox.mjs').includes("destination like 'channel:%'")&&t('api/agent-run.mjs').includes('dispatchChannelOutboxOnce')),
]);
unit('DEF-OUTBOUND-ADAPTERS-EVIDENCE','evidence/EG-0056-real-outbound-adapters.md',[
  op('outbound evidence is approved with restrictions',()=>t('evidence/EG-0056-real-outbound-adapters.md').includes('APROVADO COM RESTRICOES')),
  op('evidence records Meta Resend and Google',()=>['Meta','Resend','Google'].every(x=>t('evidence/EG-0056-real-outbound-adapters.md').includes(x))),
  op('business truth remains separate from provider acceptance',()=>t('evidence/EG-0056-real-outbound-adapters.md').includes('Resultado HTTP aceito')&&t('evidence/EG-0056-real-outbound-adapters.md').includes('webhook/reconciliacao')),
]);
unit('CODE-CONTINUOUS-AGENT-EVALS','src/agentEvals.mjs + scripts/audit-agent-evals-20x.mjs',[
  command('agent eval syntax',process.execPath,['--check','src/agentEvals.mjs']),
  command('agent eval focused tests',process.execPath,['--test','test/agent-evals-continuous.test.mjs']),
  command('agent eval adversarial 20x',process.execPath,['scripts/audit-agent-evals-20x.mjs']),
]);
unit('DEF-CONTINUOUS-AGENT-EVALS-EVIDENCE','evidence/EG-0057-continuous-agent-evaluation.md',[
  op('continuous eval evidence approved with restrictions',()=>t('evidence/EG-0057-continuous-agent-evaluation.md').includes('APROVADO COM RESTRICOES')),
  op('three independent agent eval references recorded',()=>['OpenAI','Microsoft','Google'].every(x=>t('evidence/EG-0057-continuous-agent-evaluation.md').includes(x))),
  op('offline eval does not claim commercial proof',()=>t('evidence/EG-0057-continuous-agent-evaluation.md').includes('não prova conversão')||t('evidence/EG-0057-continuous-agent-evaluation.md').includes('nao prova conversao')),
]);
unit('CODE-OUTCOME-LEARNING','src/outcomeLearning.mjs + src/revenueAgent.mjs + src/agentWorker.mjs',[
  command('outcome learning syntax',process.execPath,['--check','src/outcomeLearning.mjs']),
  command('outcome learning focused tests',process.execPath,['--test','test/outcome-learning.test.mjs']),
  command('outcome learning 20x',process.execPath,['scripts/audit-outcome-learning-20x.mjs']),
]);
unit('DEF-OUTCOME-LEARNING-EVIDENCE','evidence/EG-0058-outcome-learning-memory.md',[
  op('outcome learning evidence approved with restrictions',()=>t('evidence/EG-0058-outcome-learning-memory.md').includes('APROVADO COM RESTRICOES')),
  op('learning uses reconciled observed truth',()=>t('evidence/EG-0058-outcome-learning-memory.md').includes('telemetria persistida')&&t('evidence/EG-0058-outcome-learning-memory.md').includes('eventos financeiros reconciliados')),
  op('learning explicitly avoids causal overclaim',()=>t('evidence/EG-0058-outcome-learning-memory.md').includes('Nao significa causalidade')||t('evidence/EG-0058-outcome-learning-memory.md').includes('Não significa causalidade')),
]);
unit('CODE-PROGRESSIVE-AUTONOMY','src/autonomyPolicy.mjs + src/agentControl.mjs + src/agentWorker.mjs',[
  command('autonomy policy syntax',process.execPath,['--check','src/autonomyPolicy.mjs']),
  command('autonomy policy focused tests',process.execPath,['--test','test/autonomy-policy.test.mjs']),
  command('autonomy policy 20x',process.execPath,['scripts/audit-autonomy-policy-20x.mjs']),
]);
unit('DEF-PROGRESSIVE-AUTONOMY-EVIDENCE','evidence/EG-0059-progressive-autonomy-policy.md',[
  op('progressive autonomy evidence approved with restrictions',()=>t('evidence/EG-0059-progressive-autonomy-policy.md').includes('APROVADO COM RESTRICOES')),
  op('three independent trust references recorded',()=>['OpenAI','Microsoft','Salesforce'].every(x=>t('evidence/EG-0059-progressive-autonomy-policy.md').includes(x))),
  op('guarded remains production default',()=>t('evidence/EG-0059-progressive-autonomy-policy.md').includes('AGENT_AUTONOMY_MODE=guarded')),
]);
unit('CODE-PROVIDER-CONFIRMATION','src/providerConfirmation.mjs + provider webhooks',[
  command('provider confirmation syntax',process.execPath,['--check','src/providerConfirmation.mjs']),
  command('provider confirmation focused tests',process.execPath,['--test','test/provider-confirmation.test.mjs','test/meta-webhook.test.mjs','test/resend.test.mjs','test/agent-observability.test.mjs']),
  command('provider confirmation 20x',process.execPath,['scripts/audit-provider-confirmation-20x.mjs']),
]);
unit('DEF-PROVIDER-CONFIRMATION-EVIDENCE','evidence/EG-0060-provider-delivery-confirmation.md',[
  op('provider confirmation evidence approved with restrictions',()=>t('evidence/EG-0060-provider-delivery-confirmation.md').includes('APROVADO COM RESTRICOES')),
  op('three independent webhook references recorded',()=>['Meta','Resend','Stripe'].every(x=>t('evidence/EG-0060-provider-delivery-confirmation.md').includes(x))),
  op('commercial truth remains explicitly separate',()=>t('evidence/EG-0060-provider-delivery-confirmation.md').includes('nao conversao')&&t('evidence/EG-0060-provider-delivery-confirmation.md').includes('nao resultado comercial')),
]);
unit('CODE-YOUTUBE-RESUMABLE','src/youtubeUpload.mjs + outbound adapter',[
  command('youtube upload syntax',process.execPath,['--check','src/youtubeUpload.mjs']),
  command('youtube focused tests',process.execPath,['--test','test/youtube-upload.test.mjs','test/outbound-adapters.test.mjs']),
  command('youtube 20x audit',process.execPath,['scripts/audit-youtube-upload-20x.mjs']),
]);
unit('DEF-YOUTUBE-EVIDENCE','evidence/EG-0061-youtube-resumable-upload.md',[
  op('youtube evidence approved with restrictions',()=>t('evidence/EG-0061-youtube-resumable-upload.md').includes('APROVADO COM RESTRICOES')),
  op('three independent organizations recorded',()=>['Google','Vercel','IETF'].every(x=>t('evidence/EG-0061-youtube-resumable-upload.md').includes(x))),
  op('secrets and commercial gates remain protected',()=>t('evidence/EG-0061-youtube-resumable-upload.md').includes('nunca podem ser enviados')&&t('.env.example').includes('SALE_GLOBALLY_ENABLED=false')),
]);
unit('CODE-CONTENT-DEDUP','src/contentDedup.mjs + src/agentWorker.mjs',[
  command('content dedup syntax',process.execPath,['--check','src/contentDedup.mjs']),
  command('content dedup focused tests',process.execPath,['--test','test/content-dedup.test.mjs']),
  command('content dedup 20x',process.execPath,['scripts/audit-content-dedup-20x.mjs']),
]);
unit('DEF-CONTENT-DEDUP-EVIDENCE','evidence/EG-0062-content-deduplication.md',[
  op('content dedup evidence approved with restrictions',()=>t('evidence/EG-0062-content-deduplication.md').includes('APROVADO COM RESTRICOES')),
  op('three independent dedup references recorded',()=>['Unicode','Stanford','Google'].every(x=>t('evidence/EG-0062-content-deduplication.md').includes(x))),
  op('lexical similarity not overstated as semantic',()=>t('evidence/EG-0062-content-deduplication.md').includes('nao e compreensao semantica')),
]);
unit('CODE-V10-OFFER-RECONCILIATION','offer catalog + activation artifact gates',[
  command('V10 offer focused tests',process.execPath,['--test','test/arbm-sist-offer.test.mjs','test/activation-ready.test.mjs']),
  command('V10 offer reconciliation 20x',process.execPath,['scripts/audit-v10-offer-reconciliation-20x.mjs']),
  command('offer launch 20x',process.execPath,['scripts/audit-offer-launch-20x.mjs']),
]);
unit('DEF-V10-OFFER-EVIDENCE','evidence/EG-0063-arbm-sist-v10-offer-reconciliation.md',[
  op('V10 evidence approved with restrictions',()=>t('evidence/EG-0063-arbm-sist-v10-offer-reconciliation.md').includes('APROVADO COM RESTRICOES')),
  op('V10 verified hash recorded',()=>t('evidence/EG-0063-arbm-sist-v10-offer-reconciliation.md').includes('70F233FA2AD84B66468CCB4789E3628A171ABA97A6C5C188C01A1EF56659B4E0')),
  op('signing and public release remain blockers',()=>t('src/activationReadiness.mjs').includes('arbm_sist_code_signing_not_ready')&&t('src/activationReadiness.mjs').includes('arbm_sist_public_release_not_approved')),
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
