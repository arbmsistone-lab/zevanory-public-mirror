import test from 'node:test';
import assert from 'node:assert/strict';
import {mercadoLivreOAuthCallbackReadiness} from '../src/http/oauthMercadoLivre.mjs';

test('Mercado Livre OAuth callback advertises reserved endpoint without enabling authorization',()=>{
  const r=mercadoLivreOAuthCallbackReadiness({});
  assert.equal(r.status,200);
  assert.equal(r.body.callback_registered,true);
  assert.equal(r.body.authorization_enabled,false);
});

test('Mercado Livre OAuth callback fails closed if provider sends a code before exchange is enabled',()=>{
  const r=mercadoLivreOAuthCallbackReadiness({code:'sensitive-code',state:'opaque-state'});
  assert.equal(r.status,503);
  assert.equal(r.body.error,'oauth_exchange_not_enabled');
  assert.equal(JSON.stringify(r.body).includes('sensitive-code'),false);
});
