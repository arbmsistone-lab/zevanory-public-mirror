import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const identity=JSON.parse(await readFile(new URL('../config/brand-identity.json',import.meta.url),'utf8'));

test('ZEVANORY canonical brand identity is complete and consistent',async()=>{
  assert.equal(identity.brand,'ZEVANORY');
  assert.equal(identity.displayName,'ZEVANORY');
  assert.equal(identity.website,'https://zevanory.api.br');
  assert.equal(identity.email,'contato@zevanory.api.br');
  assert.equal(identity.whatsappDisplay,'+55 88 9234-0423');
  assert.equal(identity.whatsappE164,'558892340423');
  assert.equal(identity.avatar,'/brand/zevanory-avatar.png');
  const avatar=await stat(new URL('../public/brand/zevanory-avatar.png',import.meta.url));
  assert.ok(avatar.size>1000);
});

test('operational docs use the provider-confirmed WhatsApp number',async()=>{
  for(const rel of ['launch/ZEVANORY-CHANNEL-ACTIVATION-PACK.md','launch/ZEVANORY-COMMERCIAL-ACCOUNTS-STATUS.md']){
    const text=await readFile(new URL('../'+rel,import.meta.url),'utf8');
    assert.doesNotMatch(text,/\+55 88 99234-0423/);
    assert.match(text,/\+55 88 9234-0423/);
  }
});