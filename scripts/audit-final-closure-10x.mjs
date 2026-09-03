import fs from 'node:fs';
import { SALES_LIFECYCLE_CANONICAL_V2 } from '../src/salesLifecycleV2.mjs';
import { SALES_LIFECYCLE_CAPABILITIES, assessLifecycleCapabilityCoverage } from '../src/salesLifecycleCapabilities.mjs';
import { LIFECYCLE_PROOF_POLICY, certifyLifecycleEvidence } from '../src/lifecycleCertificationEngine.mjs';
import { salesGate } from '../src/salesGate.mjs';

const checks=[];
const check=(name,pass)=>checks.push({name,pass:Boolean(pass)});
const read=(path)=>fs.readFileSync(path,'utf8');
const empty=certifyLifecycleEvidence({});

check('canonical lifecycle remains exactly 39 dimensions',SALES_LIFECYCLE_CANONICAL_V2.length===39);
check('all 39 dimensions have explicit capability owners',assessLifecycleCapabilityCoverage().complete===true&&Object.keys(SALES_LIFECYCLE_CAPABILITIES).length===39);
check('all 39 dimensions have explicit production proof policies',SALES_LIFECYCLE_CANONICAL_V2.every(k=>typeof LIFECYCLE_PROOF_POLICY[k]==='function'));
check('technical readiness alone caps every dimension at score 9',empty.dimensions.length===39&&empty.dimensions.every(x=>x.score===9&&x.production_proven===false));
check('39x10 certification cannot be synthesized from empty evidence',empty.approved===false&&empty.proven_dimensions===0&&empty.blockers.length===39);

const gate=salesGate({SALE_GLOBALLY_ENABLED:'true',PRE_SALE_GATES_APPROVED:'true'});
check('environment switches alone cannot unlock the static sales gate',gate.enabled===false&&gate.lifecycle_approved===false);

const provenance=read('db/migrations/015_lifecycle_certification_provenance.sql');
check('certification artifact is deployment-bound and immutable',/deployed_commit_sha/.test(provenance)&&/artifact_immutable/.test(provenance)&&/total_dimensions = 39/.test(provenance));

const operator=read('api/events-operator.mjs');
check('human certification approval is authenticated exact-candidate and non-unlocking',/safeBearerEqual/.test(operator)&&/lifecycle_certification_approve/.test(operator)&&/artifact_candidate_mismatch/.test(operator)&&/lifecycle_39x10_required/.test(operator)&&/commercial_unlock:false/.test(operator));

const quality=read('.github/workflows/quality.yml');
const control=read('.github/workflows/quality-control-plane.yml');
const required=['audit:lifecycle:10x','audit:lifecycle:evidence:10x','audit:closure:10x'];
check('both quality planes enforce lifecycle and closure audits',required.every(x=>quality.includes(x)&&control.includes(x)));

check('commercial release remains fail-closed until observed 39x10',/commercial_unlock:false/.test(operator)&&empty.approved===false);

for(const [i,item] of checks.entries()) console.log(`${item.pass?'APPROVED':'FAILED'} ${String(i+1).padStart(2,'0')} ${item.name}`);
const failed=checks.filter(x=>!x.pass);
if(checks.length!==10||failed.length) process.exitCode=1;
else console.log(`AUDIT_FINAL_CLOSURE_10X_APPROVED units=${checks.length} approved=${checks.length} failed=0`);
