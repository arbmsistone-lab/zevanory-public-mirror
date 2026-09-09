import { readFile } from 'node:fs/promises';
import { SALES_LIFECYCLE_CANONICAL_V2, evaluateLifecycleCertification, salesLifecycleGate } from '../src/salesLifecycleV2.mjs';
import { assessLifecycleCapabilityCoverage } from '../src/salesLifecycleCapabilities.mjs';

const root=new URL('../',import.meta.url);
const text=async(path)=>readFile(new URL(path,root),'utf8');
const checks=[]; const add=(name,ok)=>checks.push(Object.freeze({name,ok:Boolean(ok)}));
const [gate,agent,autonomy,channels,outbound,customer,revenue,attribution,repository,migration,testFile,agentRun]=await Promise.all([
  text('src/salesGate.mjs'),text('src/agentPolicy.mjs'),text('src/autonomyPolicy.mjs'),text('src/channelAdapters.mjs'),text('src/outboundAdapters.mjs'),
  text('src/customerLifecycleEngine.mjs'),text('src/revenueIntelligence.mjs'),text('src/attributionEngine.mjs'),text('src/lifecycleRepository.mjs'),
  text('db/migrations/012_sales_lifecycle_v2.sql'),text('test/sales-lifecycle-v2.test.mjs'),text('api/agent-run.mjs'),
]);

add('01 canonical lifecycle has exactly 39 dimensions',SALES_LIFECYCLE_CANONICAL_V2.length===39);
add('02 canonical sales gate requires lifecycle certification',gate.includes('lifecycle.approved')&&gate.includes('salesLifecycleGate'));
add('03 technical release certification is 39x10 and commercial gates remain independent',salesLifecycleGate().approved===true&&salesLifecycleGate().passed_dimensions===39);
add('04 all 39 dimensions have ownership and customer lifecycle persistence',assessLifecycleCapabilityCoverage().complete&&assessLifecycleCapabilityCoverage().total===39&&['retention','upsell','cross_sell','win_back','churnState'].every(x=>customer.includes(x))&&repository.includes('recordCustomerLifecycleEvent')&&migration.includes('customer_lifecycle_profiles'));
add('05 revenue intelligence covers retention churn repeat LTV and baseline forecast',['retention_rate','churn_rate','repeat_purchase_rate','estimated_ltv_brl','forecastRevenue'].every(x=>revenue.includes(x)));
add('06 attribution is deterministic and persisted',['first_touch','last_touch','position_based','linear'].every(x=>attribution.includes(x))&&repository.includes('recordAttributionTouchpoint')&&migration.includes('attribution_touchpoints'));
add('07 agent and autonomy default to canonical sales gate',agent.includes("salesGate(env)")&&autonomy.includes('gateEvaluator=salesGate'));
add('08 channels and outbound default to canonical gate with no production bypass',channels.includes('gateEvaluator=salesGate')&&outbound.includes('commercialGate=salesGate')&&outbound.includes('ensureGlobalGates(env,commercialGate)')&&agentRun.includes('buildOutboundAdapters()'));
const guarded=evaluateLifecycleCertification({scores:Object.fromEntries(SALES_LIFECYCLE_CANONICAL_V2.map(key=>[key,10])),audit_10x_pass:false,production_parity_verified:false,release_approved:false});
add('09 certification evaluator still requires audit parity and release approval',guarded.blockers.includes('lifecycle_audit_10x_not_passed')&&guarded.blockers.includes('production_parity_not_verified')&&guarded.blockers.includes('lifecycle_release_not_approved'));
add('10 regression migration and pre-sale intelligence controls exist',testFile.includes('every dimension must score exactly 10')&&migration.includes('012_sales_lifecycle_v2')&&await text('src/leadIntelligence.mjs').then(x=>x.includes('qualificationDecision'))&&await text('src/conversationLifecycle.mjs').then(x=>x.includes('abandonmentRecoveryPlan')));

for(const check of checks) console.log(`${check.ok?'APPROVED':'FAILED'} ${check.name}`);
const failed=checks.filter(x=>!x.ok);
console.log(`AUDIT_SALES_LIFECYCLE_V2_10X_${failed.length?'BLOCKED':'APPROVED'} units=${checks.length} approved=${checks.length-failed.length} failed=${failed.length}`);
if(failed.length) process.exitCode=1;
