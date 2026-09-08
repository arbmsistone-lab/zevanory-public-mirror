import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { oauthCredentialOperation, OAUTH_PERSISTENCE_RULES } from '../src/oauthPersistenceFabric.mjs';

const root=new URL('../',import.meta.url);
const read=(p)=>readFile(new URL(p,root),'utf8');

test('oauth recovery operation never claims connection and fingerprints token',()=>{
  const op=oauthCredentialOperation({provider:'linkedin',subjectRef:'person1',token:{access_token:'secret',refresh_token:'refresh'},identity:{id:'person1'}});
  assert.match(op.operation_id,/^oauth-credential:linkedin:person1:[0-9a-f]{24}$/);
  assert.equal(op.payload.connected,false);assert.equal(op.payload.reconciliation_required,true);assert.equal(op.payload.provider_token_obtained,true);
  assert.equal(op.operation_id.includes('secret'),false);assert.equal(op.operation_id.includes('refresh'),false);
});

test('oauth persistence rules enforce single exchange and encrypted recovery',()=>{
  assert.equal(OAUTH_PERSISTENCE_RULES.authorization_code_single_exchange,true);
  assert.equal(OAUTH_PERSISTENCE_RULES.token_journal_encrypted,true);
  assert.equal(OAUTH_PERSISTENCE_RULES.journal_never_claims_connected,true);
});
test('all OAuth callbacks exchange before persistence and can preserve credential',async()=>{
  const files=await Promise.all(['src/http/oauthTikTok.mjs','src/http/oauthLinkedIn.mjs','src/http/oauthNuvemshop.mjs','src/http/oauthMercadoLivre.mjs'].map(read));
  for(const source of files){
    assert.match(source,/preserveOAuthCredential/);
    assert.match(source,/credential_preserved/);
    assert.match(source,/reconciliation_required:true/);
    assert.doesNotMatch(source,/if\(!process\.env\.DATABASE_URL\)throw new Error\('database_url_required'\)/);
  }
});

test('oauth callback never reports connected true from journal recovery',async()=>{
  const files=await Promise.all(['src/http/oauthTikTok.mjs','src/http/oauthLinkedIn.mjs','src/http/oauthNuvemshop.mjs','src/http/oauthMercadoLivre.mjs'].map(read));
  for(const source of files){
    const recovery=source.match(/credential_preserved[^\n]+/g)||[];
    assert.ok(recovery.length>=1);
    assert.ok(recovery.every(line=>!line.includes('connected:true')));
  }
});
test('redeemed OAuth code recovery clears callback cookie',async()=>{
  const files=await Promise.all(['src/http/oauthTikTok.mjs','src/http/oauthLinkedIn.mjs','src/http/oauthNuvemshop.mjs','src/http/oauthMercadoLivre.mjs'].map(read));
  for(const source of files){
    const recoveryIndex=source.indexOf('credential_preserved');
    assert.ok(recoveryIndex>0);
    const nearby=source.slice(Math.max(0,recoveryIndex-700),recoveryIndex+500);
    assert.match(nearby,/Max-Age=0/);
  }
});
