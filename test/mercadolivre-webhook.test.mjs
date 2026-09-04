import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMercadoLivreNotification} from '../src/http/webhookMercadoLivre.mjs';

test('Mercado Livre webhook validates exact app and seller identity',()=>{
  const env={MERCADOLIVRE_APP_ID:'123',MERCADOLIVRE_SELLER_ID:'456'};
  const good=validateMercadoLivreNotification({application_id:123,user_id:456,topic:'orders_v2',resource:'/orders/789'},env);
  assert.equal(good.ok,true);assert.equal(good.topic,'orders_v2');
  assert.equal(validateMercadoLivreNotification({application_id:999,user_id:456,topic:'orders_v2',resource:'/orders/789'},env).status,401);
});

test('Mercado Livre webhook fails closed before identity configuration',()=>{
  const r=validateMercadoLivreNotification({application_id:123,user_id:456,topic:'items',resource:'/items/MLB1'},{});
  assert.equal(r.ok,false);assert.equal(r.status,503);
});

test('Mercado Livre webhook rejects unsafe resource paths',()=>{
  const env={MERCADOLIVRE_APP_ID:'123',MERCADOLIVRE_SELLER_ID:'456'};
  assert.equal(validateMercadoLivreNotification({application_id:123,user_id:456,topic:'items',resource:'https://evil.example/x'},env).status,400);
  assert.equal(validateMercadoLivreNotification({application_id:123,user_id:456,topic:'items',resource:'//evil.example/x'},env).status,400);
});
