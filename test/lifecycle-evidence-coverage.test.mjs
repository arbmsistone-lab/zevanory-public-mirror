import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OPERATOR_EVIDENCE_EVENTS, validateEventName } from '../src/telemetry.mjs';
import { SALES_LIFECYCLE_LABELS } from '../src/salesLifecycleV2.mjs';

const expected=['identity_verified','enrichment_verified','scoring_completed','prioritization_completed','first_response_confirmed','discovery_completed','nurturing_touch_confirmed','objection_handled','negotiation_completed','abandonment_recovered','fulfillment_confirmed'];
test('operator evidence events cover missing observable lifecycle transitions',()=>{
  assert.deepEqual([...OPERATOR_EVIDENCE_EVENTS],expected);
  assert.ok(expected.every(validateEventName));
});
test('operator evidence path requires an existing lead and does not forge telemetry stages',()=>{
  const source=fs.readFileSync('api/events-operator.mjs','utf8');
  assert.match(source,/evidenceOnly&&current===null/);
  assert.match(source,/recordVerifiedLifecycleEvidence/);
  assert.match(source,/agent_job_queued:false/);
});
test('evidence snapshot consumes trusted identity fulfillment and real customer profiles',()=>{
  const source=fs.readFileSync('src/lifecycleEvidenceSnapshot.mjs','utf8');
  assert.match(source,/identified_leads:directEvidence\.identity/);
  assert.match(source,/directEvidence\.fulfillment/);
  assert.match(source,/customer_lifecycle_profiles/);
});
test('public lifecycle labels render clean Portuguese UTF-8',()=>{
  assert.equal(SALES_LIFECYCLE_LABELS.acquisition,'Aquisição');
  assert.equal(SALES_LIFECYCLE_LABELS.qualification,'Qualificação');
  assert.equal(SALES_LIFECYCLE_LABELS.next_best_action,'Próxima melhor ação');
});
