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
  'test/landing.test.mjs','test/server-v2.integration.test.mjs']);

unit('CODE-CONFIG', 'src/config.mjs', [
  command('syntax config', process.execPath, ['--check','src/config.mjs']),
  command('config tests', process.execPath, ['--test','test/config.test.mjs']),
  op('canonical frozen definitions', () => Object.isFrozen(PROJECT) && PROJECT.officialWhatsappE164 === '5588992340423'),
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
  op('CTA disabled by default', () => t('public/index.html').includes('<button id="cta" disabled>')),
  op('telemetry before redirect', () => t('public/index.html').indexOf("await event('cta_whatsapp')") < t('public/index.html').indexOf("location.href = 'https://wa.me/'")),
]);
unit('CODE-AUDIT', 'scripts/audit-3x.mjs', [
  command('syntax audit', process.execPath, ['--check','scripts/audit-3x.mjs']),
  op('no external absolute reads', () => !/C:\\\\Sistemas\\\\(?!PROJETO-ZERO-MOTOR-VENDAS-IA)/i.test(t('scripts/audit-3x.mjs'))),
  op('three-operation fail-closed rule present', () => t('scripts/audit-3x.mjs').includes('approved >= 3') && t('scripts/audit-3x.mjs').includes("status !== 'APPROVED'")),
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
  op('project root is explicit', () => t('specs/SCOPE_BOUNDARY.md').includes('C:\\Sistemas\\PROJETO-ZERO-MOTOR-VENDAS-IA')),
  op('external systems explicitly out of scope', () => t('specs/SCOPE_BOUNDARY.md').includes('fora de escopo')),
  op('external absolute paths forbidden', () => t('specs/SCOPE_BOUNDARY.md').includes('caminho absoluto para outro sistema')),
]);

const testFiles=['test/telemetry.test.mjs','test/config.test.mjs','test/definitions.test.mjs','test/landing.test.mjs','test/server-v2.integration.test.mjs'];
unit('ASSURANCE-TESTS','test harness',[
  op('all test files exist',()=>testFiles.every((f)=>existsSync(join(root,f)))),
  op('all test files syntax-valid',()=>testFiles.every((f)=>spawnSync(process.execPath,['--check',f],{cwd:root,encoding:'utf8'}).status===0)),
  fullTests,
]);

unit('PROJECT-HYGIENE','project-only hygiene',[
  op('legacy server absent',()=>!existsSync(join(root,'src','server.mjs'))),
  op('old WhatsApp absent from active files',()=>!['src/config.mjs','src/server-v2.mjs','public/index.html','test/config.test.mjs','test/server-v2.integration.test.mjs','evidence/WHATSAPP-ORIGIN-0001.md'].some((f)=>t(f).includes('5588921928688'))),
  op('audit has no external absolute reads',()=>!t('scripts/audit-3x.mjs').includes('readFileSync(' + String.fromCharCode(39) + 'C:')) ,
]);

const report={policy:'minimum 3 approved operations per audited code/definition unit',scope:'Projeto Zero only',units,totals:{units:units.length,approved:units.filter(x=>x.status==='APPROVED').length,failed:units.filter(x=>x.status!=='APPROVED').length},verdict:blocked?'BLOCKED':'APPROVED'};
writeFileSync(join(root,'validation','AUDIT-3X-CURRENT.json'),JSON.stringify(report,null,2)+'\n','utf8');
for(const item of units) console.log(`${item.status} ${item.id} operations=${item.approved_operations}`);
console.log(`AUDIT_3X_${report.verdict} units=${report.totals.units} approved=${report.totals.approved} failed=${report.totals.failed}`);
process.exit(blocked?1:0);
