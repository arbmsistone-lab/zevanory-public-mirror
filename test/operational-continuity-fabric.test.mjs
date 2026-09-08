import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root=new URL('../',import.meta.url);

test('agent run preserves pre-execution trigger and reconciles ambiguous execution',async()=>{
  const source=await readFile(new URL('api/agent-run.mjs',root),'utf8');
  assert.match(source,/agent\.run_request/);assert.match(source,/pending_storage/);assert.match(source,/executed:false/);
  assert.match(source,/agent\.run_reconciliation/);assert.match(source,/executed:null/);assert.match(source,/reconciliation_required:true/);
});

test('robot control preserves authenticated write intent without claiming execution',async()=>{
  const source=await readFile(new URL('api/robot-control.mjs',root),'utf8');
  assert.match(source,/controlOperation/);assert.match(source,/pending_storage/);assert.match(source,/executed:false/);
  assert.match(source,/agent\.control_reconciliation/);assert.match(source,/reconciliation_required:true/);
});

test('robot control read path uses verified read fabric',async()=>{
  const source=await readFile(new URL('api/robot-control.mjs',root),'utf8');
  assert.match(source,/executeVerifiedRead/);assert.match(source,/canonical_read/);
});
