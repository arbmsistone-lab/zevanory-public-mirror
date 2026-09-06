import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { issueArtifactDownload, consumeArtifactDownload, hashArtifactToken, PRIVATE_ARTIFACT } from '../src/artifactDelivery.mjs';

test('private artifact is pinned to canonical ZEVANORY Negocio Completo v1.1 hash',()=>{
  assert.equal(PRIVATE_ARTIFACT.key,'zevanory/v1.1/ZEVANORY_Negocio_Completo_v1.1.zip');
  assert.equal(PRIVATE_ARTIFACT.filename,'ZEVANORY_Negocio_Completo_v1.1.zip');
  assert.equal(PRIVATE_ARTIFACT.sha256,'8A0D44D43662367149E84F11817485799FA361ACDC65DDEA319CA3FA79C2571E');
});

test('download token is random, hashed at rest and requires paid reconciled order',async()=>{
  const calls=[];const order='550e8400-e29b-41d4-a716-446655440000';
  const sql={query:async(text,args)=>{calls.push({text,args});
    if(text.startsWith('select o.order_id'))return [{order_id:order}];
    if(text.startsWith('insert into artifact_download_tokens'))return [{token_id:'t',order_id:order,expires_at:new Date(Date.now()+60000)}];
    return [];
  }};
  const issued=await issueArtifactDownload(sql,{orderId:order});
  assert.ok(issued.token.length>=32);
  assert.equal(calls[1].args[2],hashArtifactToken(issued.token));
  assert.notEqual(calls[1].args[2],issued.token);
  assert.match(calls[0].text,/status='paid'/);
  assert.match(calls[0].text,/payment_confirmed/);
});

test('download claim is atomic single-use and revalidates payment truth',async()=>{
  const calls=[];const sql={query:async(text,args)=>{calls.push({text,args});return [{token_id:'t',order_id:'o',artifact_key:PRIVATE_ARTIFACT.key,artifact_sha256:PRIVATE_ARTIFACT.sha256,expires_at:new Date(),used_at:new Date()}];}};
  const claimed=await consumeArtifactDownload(sql,{token:'x'.repeat(48)});
  assert.equal(claimed.artifact_key,PRIVATE_ARTIFACT.key);
  assert.match(calls[0].text,/used_at is null/);
  assert.match(calls[0].text,/expires_at>now/);
  assert.match(calls[0].text,/status='paid'/);
  assert.match(calls[0].text,/payment_confirmed/);
  assert.match(calls[0].text,/set used_at=now/);
});

test('Cloudflare route never exposes artifact without one-time token path',()=>{
  const worker=fs.readFileSync(new URL('../src/cloudflare-worker.mjs',import.meta.url),'utf8');
  const route=fs.readFileSync(new URL('../src/cloudflareArtifactRoutes.mjs',import.meta.url),'utf8');
  const config=fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');
  assert.match(worker,/\/private\/artifacts\/issue/);
  assert.match(worker,/\/private\/artifacts\/download/);
  assert.match(route,/operator_auth_required/);
  assert.match(route,/artifact_integrity_failed/);
  assert.match(config,/ZEVANORY_PRIVATE_ARTIFACTS/);
});
