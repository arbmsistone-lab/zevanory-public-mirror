import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Meta Graph API default is pinned to current v26.0',()=>{
  const env=fs.readFileSync(new URL('../.env.example',import.meta.url),'utf8');
  assert.match(env,/^META_GRAPH_VERSION=v26\.0$/m);
  assert.doesNotMatch(env,/META_GRAPH_VERSION=v23\.0/);
});

test('Meta adapters remain runtime-versioned and fail closed',()=>{
  const outbound=fs.readFileSync(new URL('../src/outboundAdapters.mjs',import.meta.url),'utf8');
  assert.match(outbound,/META_GRAPH_VERSION/);
  assert.match(outbound,/meta_graph_version_missing/);
  assert.doesNotMatch(outbound,/graph\.facebook\.com\/v23\.0/);
});

test('v26 reconciliation has independent evidence and preserves closed gates',()=>{
  const evidence=fs.readFileSync(new URL('../evidence/EG-0064-meta-graph-v26.md',import.meta.url),'utf8');
  assert.match(evidence,/Independent evidence/);
  assert.match(evidence,/commercial gates remain OFF/i);
  assert.match(evidence,/Verdict: APPROVED/);
});
