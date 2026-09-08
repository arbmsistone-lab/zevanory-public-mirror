import test from 'node:test';
import assert from 'node:assert/strict';
import { defineDeploymentProvider, deployWithFabric, collectDeploymentProofs, certifyDeploymentEvidence } from '../src/deploymentFabric.mjs';

const sha='a'.repeat(40);
const make=(id,domain,{fail=false,proofSha=sha}={})=>defineDeploymentProvider({id,independenceDomain:domain,cost:0,
  deploy:async()=>{if(fail)throw new Error('deploy_down');return {url:`https://${id}.example`};},
  verify:async()=>({status:'pass',artifact_sha:proofSha,provider:id,independence_domain:domain}),
});

test('deployment fabric reroutes between independent providers',async()=>{
  const out=await deployWithFabric({sha,providers:[make('a','a',{fail:true}),make('b','b')]});
  assert.equal(out.ok,true);assert.equal(out.provider,'b');assert.equal(out.attempts.length,2);
});

test('deployment provider rejects proof for wrong SHA',async()=>{
  const out=await deployWithFabric({sha,providers:[make('bad','bad',{proofSha:'b'.repeat(40)})]});
  assert.equal(out.ok,false);assert.equal(out.preserved,true);
});
test('critical deployment certification requires independent exact-SHA proofs',async()=>{
  const {proofs}=await collectDeploymentProofs({sha,providers:[make('a','domain-a'),make('b','domain-b')]});
  const certified=certifyDeploymentEvidence(proofs,{required:2});
  assert.equal(certified.pass,true);assert.equal(certified.independent_domains,2);
  const correlated=await collectDeploymentProofs({sha,providers:[make('c','same'),make('d','same')]});
  assert.equal(certifyDeploymentEvidence(correlated.proofs,{required:2}).pass,false);
});
