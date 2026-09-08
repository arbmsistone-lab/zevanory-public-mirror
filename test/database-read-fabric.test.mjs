import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifiedReadRoutes, executeVerifiedRead } from '../src/databaseReadFabric.mjs';

test('unverified read replicas never enter routing pool',()=>{
  const env={DATABASE_URL:'postgres://primary',DATABASE_CANONICAL_DATASET_ID:'ds-1',DATABASE_READ_1_URL:'postgres://replica',DATABASE_READ_1_READ_ONLY:'true',DATABASE_READ_1_DATASET_ID:'ds-1'};
  const routes=buildVerifiedReadRoutes(env);
  assert.equal(routes.length,1);assert.equal(routes[0].canonical,true);
});

test('verified read-only route for same dataset is eligible',()=>{
  const env={DATABASE_URL:'postgres://primary',DATABASE_CANONICAL_DATASET_ID:'ds-1',DATABASE_READ_1_URL:'postgres://replica',DATABASE_READ_1_VERIFIED:'true',DATABASE_READ_1_READ_ONLY:'true',DATABASE_READ_1_DATASET_ID:'ds-1',DATABASE_READ_1_ID:'replica-a'};
  const routes=buildVerifiedReadRoutes(env);
  assert.equal(routes.length,2);assert.equal(routes[1].id,'replica-a');assert.equal(routes[1].read_only,true);
});
test('read fabric reroutes after canonical read failure',async()=>{
  const env={DATABASE_URL:'postgres://primary',DATABASE_CANONICAL_DATASET_ID:'ds-1',DATABASE_READ_1_URL:'postgres://replica',DATABASE_READ_1_VERIFIED:'true',DATABASE_READ_1_READ_ONLY:'true',DATABASE_READ_1_DATASET_ID:'ds-1',DATABASE_READ_1_ID:'replica-a'};
  const out=await executeVerifiedRead({env,connect:(url)=>({url}),read:async(sql)=>{if(sql.url.includes('primary'))throw new Error('primary_down');return {ok:true};}});
  assert.equal(out.ok,true);assert.equal(out.route,'replica-a');assert.equal(out.canonical,false);assert.equal(out.attempts.length,2);
});

test('mismatched dataset replica is rejected',()=>{
  const env={DATABASE_URL:'postgres://primary',DATABASE_CANONICAL_DATASET_ID:'ds-1',DATABASE_READ_1_URL:'postgres://replica',DATABASE_READ_1_VERIFIED:'true',DATABASE_READ_1_READ_ONLY:'true',DATABASE_READ_1_DATASET_ID:'other'};
  assert.equal(buildVerifiedReadRoutes(env).length,1);
});
