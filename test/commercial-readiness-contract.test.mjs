import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ARBM_ONE_OFFER } from '../src/arbmOneOffer.mjs';
const load=(name)=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8');

test('ZEVANORY ONE commercial contract is machine-auditable while sales remain locked',()=>{
  const c=ARBM_ONE_OFFER.commercial_contract;
  assert.equal(ARBM_ONE_OFFER.sellable,false); assert.equal(ARBM_ONE_OFFER.checkout_enabled,false);
  assert.equal(ARBM_ONE_OFFER.commercial_release_gate,'ARBM_ONE_COMMERCIAL_RELEASE_APPROVED');
  assert.equal(c.standard_provisioning_target_business_days,5); assert.equal(c.availability_target_monthly_pct,99.9);
  assert.equal(c.critical_incident_initial_response_target_business_hours,4); assert.equal(c.customer_data_export_window_days_after_cancellation,30);
  assert.equal(c.support_channel,'suporte@zevanory.api.br');
});

test('public software offers expose price scope support and cancellation before checkout',async()=>{
  const one=await load('zevanory-one.html'), sist=await load('arbm-sist.html');
  for(const value of ['R$ 697/mês','R$ 1.490','99,9%','suporte@zevanory.api.br','Cancelamento']) assert.match(one,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
  for(const value of ['R$ 0','R$ 1.197','R$ 79,90/mês','R$ 19,90/mês','suporte@zevanory.api.br','cancelamento']) assert.match(sist,new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));
});

test('digital product pages expose price delivery support and cancellation',async()=>{
  const pages={'ia-na-pratica.html':'R$ 197','vendas-na-pratica.html':'R$ 197','lucro-e-caixa.html':'R$ 247','combo-ia-vendas.html':'R$ 297','negocio-completo.html':'R$ 397'};
  for(const [file,price] of Object.entries(pages)){const html=await load(file); assert.match(html,new RegExp(price.replace('$','\\$'))); assert.match(html,/pagamento reconciliado/i); assert.match(html,/suporte@zevanory\.api\.br/i); assert.match(html,/cancelamento/i);}
});
