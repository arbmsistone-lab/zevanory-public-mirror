import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandCenter } from '../src/commandCenter.mjs';

test('command center prioritizes real aggregate operational pressure',()=>{
  const center=buildCommandCenter({
    leads:[{stage:'new',count:3},{stage:'qualified',count:2},{stage:'paid',count:1}],
    actions:[{status:'scheduled',count:4},{status:'completed',count:6},{status:'blocked',count:1}],
    dueBuckets:[{bucket:'overdue',count:2},{bucket:'due_24h',count:1},{bucket:'later',count:1}],
    riskBuckets:[{bucket:'missing_next_action',count:2},{bucket:'stale',count:1}],
  });
  assert.equal(center.pipeline.open,5);
  assert.equal(center.work_queue.pressure,6);
  assert.equal(center.execution.action_completion_rate,6/11);
  assert.equal(center.execution.predictive_forecast_available,false);
  assert.equal(center.execution.next_best_action_mode,'rules_based');
});

test('command center never invents forecast without baseline',()=>{
  const center=buildCommandCenter();
  assert.equal(center.execution.forecast_mode,'baseline_required');
  assert.equal(center.execution.action_completion_rate,null);
  assert.equal(center.work_queue.pressure,0);
});
