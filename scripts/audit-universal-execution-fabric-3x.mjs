import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildJournalEntry, defineJournalProvider, appendJournalQuorum } from '../src/durableOperationJournal.mjs';
import { defineObservabilitySink, emitObservabilityCopies } from '../src/observabilityFabric.mjs';
import { defineDeploymentProvider, collectDeploymentProofs, certifyDeploymentEvidence } from '../src/deploymentFabric.mjs';
import { STORAGE_FABRIC_RULES } from '../src/storageFabric.mjs';
import { FINANCIAL_RECONCILIATION_RULES } from '../src/financialReconciliationFabric.mjs';
import { OAUTH_PERSISTENCE_RULES } from '../src/oauthPersistenceFabric.mjs';
import { PROVIDER_CONFIRMATION_RULES } from '../src/providerConfirmationFabric.mjs';

const root=new URL('../',import.meta.url);
const text=async(path)=>readFile(new URL(path,root),'utf8');
const checks=[];
const add=(audit,name,pass)=>checks.push({audit,name,pass:Boolean(pass)});
const sha='a'.repeat(40);

async function structural(){
  const [fabric,journal,obs,deploy,channels,storage,readFabric,financial]=await Promise.all([
    text('src/universalExecutionFabric.mjs'),text('src/durableOperationJournal.mjs'),text('src/observabilityFabric.mjs'),text('src/deploymentFabric.mjs'),text('src/channelProviderRegistry.mjs'),text('src/storageFabric.mjs'),text('src/databaseReadFabric.mjs'),text('src/financialReconciliationFabric.mjs')
  ]);
  add('structural','provider named core dependency forbidden',fabric.includes('provider_named_core_dependency_forbidden:true'));
  add('structural','durable journal capability',journal.includes("capabilities:['durable:journal']"));
  add('structural','observability capability',obs.includes("capabilities:['observability:log']"));
  add('structural','deployment capability',deploy.includes("capabilities:['deploy:preview','deploy:verify']"));
  add('structural','channel capability registry',channels.includes('buildUniversalChannelAdapter'));
  add('structural','storage fabric forbids blind failover',storage.includes('no_blind_database_failover:true'));
  add('structural','storage fabric requires reconciliation after attempted mutation',storage.includes('postattempt_failure_requires_reconciliation:true'));
  add('structural','read fabric excludes unverified replicas',readFabric.includes('VERIFIED')&&readFabric.includes('READ_ONLY')&&readFabric.includes('DATASET_ID'));
  add('structural','financial reconciliation ledger is journal-backed and non-authoritative',financial.includes('financial_truth:false')&&financial.includes('reconciliation_required:true'));
}
async function functional(){
  const entry=buildJournalEntry({operationId:'audit-op',operationType:'audit',payload:{ok:true}});
  const j1=defineJournalProvider({id:'j1',independenceDomain:'j1',append:async()=>({preserved:true})});
  const j2=defineJournalProvider({id:'j2',independenceDomain:'j2',append:async()=>({preserved:true})});
  const jq=await appendJournalQuorum(entry,[j1,j2],{requiredCopies:2});
  add('functional','journal independent quorum',jq.preserved&&jq.independent_domains===2);
  const s1=defineObservabilitySink({id:'s1',independenceDomain:'s1',emit:async()=>({accepted:true})});
  const s2=defineObservabilitySink({id:'s2',independenceDomain:'s2',emit:async()=>({accepted:true})});
  const oq=await emitObservabilityCopies({event:'audit'},[s1,s2],{requiredCopies:2});
  add('functional','observability independent quorum',oq.durable&&oq.independent_domains===2);
  add('functional','pre-write outage may replay only through journal',STORAGE_FABRIC_RULES.prewrite_unavailability_can_replay===true&&STORAGE_FABRIC_RULES.idempotency_required===true);
  add('functional','post-attempt failure requires reconciliation',STORAGE_FABRIC_RULES.postattempt_failure_requires_reconciliation===true&&STORAGE_FABRIC_RULES.no_blind_database_failover===true);
  add('functional','journal never proves payment or fulfillment',FINANCIAL_RECONCILIATION_RULES.journal_never_proves_payment===true&&FINANCIAL_RECONCILIATION_RULES.journal_never_unlocks_fulfillment===true);
  add('functional','ambiguous checkout never auto retries provider',FINANCIAL_RECONCILIATION_RULES.ambiguous_checkout_never_auto_retries_provider===true&&FINANCIAL_RECONCILIATION_RULES.financial_write_never_uses_read_replica===true);
  add('functional','oauth code is single exchange and journal never claims connected',OAUTH_PERSISTENCE_RULES.authorization_code_single_exchange===true&&OAUTH_PERSISTENCE_RULES.journal_never_claims_connected===true&&OAUTH_PERSISTENCE_RULES.token_journal_encrypted===true);
  add('functional','provider confirmations are atomic and journal is non-authoritative',PROVIDER_CONFIRMATION_RULES.atomic_canonical_update===true&&PROVIDER_CONFIRMATION_RULES.journal_never_marks_confirmed===true&&PROVIDER_CONFIRMATION_RULES.replay_requires_idempotent_event_id===true);
}

async function integration(){
  const make=(id,domain)=>defineDeploymentProvider({id,independenceDomain:domain,deploy:async()=>({id}),verify:async()=>({status:'pass',artifact_sha:sha,provider:id,independence_domain:domain})});
  const {proofs}=await collectDeploymentProofs({sha,providers:[make('d1','domain-a'),make('d2','domain-b')]});
  const cert=certifyDeploymentEvidence(proofs,{required:2});
  add('integration','critical deploy exact-SHA independent quorum',cert.pass&&cert.independent_domains===2);
  const [master,publicEvents,operatorEvents,statusApi,assuranceApi,agentStatusApi,checkoutAsaas,checkoutMp,webhookAsaas,webhookMp,fulfillment,agentRun,robotControl,preSale,activation,livePlan,providerConfirmation,...oauthCallbacks]=await Promise.all([text('ZEVANORY_MASTER.md'),text('api/events-public.mjs'),text('api/events-operator.mjs'),text('api/status.mjs'),text('api/assurance.mjs'),text('api/agent-status.mjs'),text('src/http/checkoutAsaas.mjs'),text('src/http/checkoutMercadoPago.mjs'),text('src/http/webhookAsaas.mjs'),text('src/http/webhookMercadoPago.mjs'),text('src/cloudflareArtifactRoutes.mjs'),text('api/agent-run.mjs'),text('api/robot-control.mjs'),text('src/preSaleReadiness.mjs'),text('src/activationPlan.mjs'),text('src/liveActionPlan.mjs'),text('src/providerConfirmation.mjs'),text('src/http/oauthTikTok.mjs'),text('src/http/oauthLinkedIn.mjs'),text('src/http/oauthNuvemshop.mjs'),text('src/http/oauthMercadoLivre.mjs')]);
  add('integration','canonical universal rule present',master.includes('UNIVERSAL EXECUTION FABRIC'));
  add('integration','public telemetry uses storage fabric',publicEvents.includes('executeStorageMutation')&&publicEvents.includes('replayable:true'));
  add('integration','operator events preserve intent but sensitive approvals stay database gated',operatorEvents.includes('pending_validation:true')&&operatorEvents.includes("name==='lifecycle_certification_approve'")&&operatorEvents.includes('operational_storage_unavailable'));
  add('integration','operational read surfaces use verified read fabric',[statusApi,assuranceApi,agentStatusApi].every(value=>value.includes('executeVerifiedRead')));
  add('integration','checkout preserves intent before provider and evidence after provider',[checkoutAsaas,checkoutMp].every(value=>value.includes('preserveCheckoutIntent')&&value.includes('checkout_provider_accepted_storage_unconfirmed')));
  add('integration','financial webhooks preserve provider truth for later canonical reconciliation',[webhookAsaas,webhookMp].every(value=>value.includes('webhook_pending_canonical_reconciliation')&&value.includes('financial_truth:false')));
  add('integration','mercadopago webhook is not tied to nominal selected provider',!webhookMp.includes('financial_provider_not_selected'));
  add('integration','fulfillment never treats journal as delivery authority',fulfillment.includes('issued:false')&&fulfillment.includes('pending_validation')&&fulfillment.includes('download_validation_unavailable'));
  add('integration','agent trigger preserves before execution and reconciles ambiguous execution',agentRun.includes('agent.run_request')&&agentRun.includes('agent.run_reconciliation')&&agentRun.includes('reconciliation_required:true'));
  add('integration','robot control writes preserve intent while reads use verified fabric',robotControl.includes('pending_storage')&&robotControl.includes('agent.control_reconciliation')&&robotControl.includes('executeVerifiedRead'));
  add('integration','pre-sale gate is provider-neutral',preSale.includes('domain_ownership_unverified')&&preSale.includes('payment_sandbox_capacity_unavailable')&&!preSale.includes('vercel_ownership_unverified')&&!preSale.includes('payment_provider_not_selected'));
  add('integration','activation plan requires payment capacity not vendor',activation.includes('payment_provider_pool_unavailable')&&!activation.includes('asaas_production_not_configured:requirement')&&!activation.includes('mercadopago_production_not_configured:requirement'));
  add('integration','financial live plan uses selected decision or capability',livePlan.includes("'capability:payment'")&&!/env\?*\.?PAYMENT_PROVIDER/.test(livePlan));
  add('integration','provider confirmation canonical update is atomic',providerConfirmation.includes('with updated_outbox as')&&providerConfirmation.includes('updated_job as'));
  add('integration','oauth callbacks preserve redeemed credentials without claiming connected',oauthCallbacks.every(value=>value.includes('preserveOAuthCredential')&&value.includes('credential_preserved')&&value.includes('reconciliation_required:true')&&!value.includes("if(!process.env.DATABASE_URL)throw new Error('database_url_required')")));
}

export async function main(){
  await structural();await functional();await integration();
  const failed=checks.filter(x=>!x.pass);console.log(JSON.stringify({audit:'UNIVERSAL_EXECUTION_FABRIC_3X',ok:failed.length===0,checks,failed},null,2));
  if(failed.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
