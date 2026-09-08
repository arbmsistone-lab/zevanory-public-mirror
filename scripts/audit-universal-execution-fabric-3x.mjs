import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildJournalEntry, defineJournalProvider, appendJournalQuorum } from '../src/durableOperationJournal.mjs';
import { defineObservabilitySink, emitObservabilityCopies } from '../src/observabilityFabric.mjs';
import { defineDeploymentProvider, collectDeploymentProofs, certifyDeploymentEvidence } from '../src/deploymentFabric.mjs';
import { STORAGE_FABRIC_RULES } from '../src/storageFabric.mjs';

const root=new URL('../',import.meta.url);
const text=async(path)=>readFile(new URL(path,root),'utf8');
const checks=[];
const add=(audit,name,pass)=>checks.push({audit,name,pass:Boolean(pass)});
const sha='a'.repeat(40);

async function structural(){
  const [fabric,journal,obs,deploy,channels,storage]=await Promise.all([
    text('src/universalExecutionFabric.mjs'),text('src/durableOperationJournal.mjs'),text('src/observabilityFabric.mjs'),text('src/deploymentFabric.mjs'),text('src/channelProviderRegistry.mjs'),text('src/storageFabric.mjs')
  ]);
  add('structural','provider named core dependency forbidden',fabric.includes('provider_named_core_dependency_forbidden:true'));
  add('structural','durable journal capability',journal.includes("capabilities:['durable:journal']"));
  add('structural','observability capability',obs.includes("capabilities:['observability:log']"));
  add('structural','deployment capability',deploy.includes("capabilities:['deploy:preview','deploy:verify']"));
  add('structural','channel capability registry',channels.includes('buildUniversalChannelAdapter'));
  add('structural','storage fabric forbids blind failover',storage.includes('no_blind_database_failover:true'));
  add('structural','storage fabric requires reconciliation after attempted mutation',storage.includes('postattempt_failure_requires_reconciliation:true'));
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
}

async function integration(){
  const make=(id,domain)=>defineDeploymentProvider({id,independenceDomain:domain,deploy:async()=>({id}),verify:async()=>({status:'pass',artifact_sha:sha,provider:id,independence_domain:domain})});
  const {proofs}=await collectDeploymentProofs({sha,providers:[make('d1','domain-a'),make('d2','domain-b')]});
  const cert=certifyDeploymentEvidence(proofs,{required:2});
  add('integration','critical deploy exact-SHA independent quorum',cert.pass&&cert.independent_domains===2);
  const [master,publicEvents,operatorEvents]=await Promise.all([text('ZEVANORY_MASTER.md'),text('api/events-public.mjs'),text('api/events-operator.mjs')]);
  add('integration','canonical universal rule present',master.includes('UNIVERSAL EXECUTION FABRIC'));
  add('integration','public telemetry uses storage fabric',publicEvents.includes('executeStorageMutation')&&publicEvents.includes('replayable:true'));
  add('integration','operator events preserve intent but sensitive approvals stay database gated',operatorEvents.includes('pending_validation:true')&&operatorEvents.includes("name==='lifecycle_certification_approve'")&&operatorEvents.includes('operational_storage_unavailable'));
}

export async function main(){
  await structural();await functional();await integration();
  const failed=checks.filter(x=>!x.pass);console.log(JSON.stringify({audit:'UNIVERSAL_EXECUTION_FABRIC_3X',ok:failed.length===0,checks,failed},null,2));
  if(failed.length)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
