import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMERCIAL_MODEL, classifyOfferType, revenueRecognitionRule, requiresInventory } from '../src/commercialModel.mjs';
import { evaluateCommercialCompliance } from '../src/complianceReadiness.mjs';
import { evaluateActivationReadiness } from '../src/activationReadiness.mjs';

test('commercial model is inventory-free and separates affiliate revenue',()=>{
  assert.equal(COMMERCIAL_MODEL.inventory,'none');
  assert.equal(classifyOfferType('service'),'service');
  assert.equal(classifyOfferType('affiliate_product'),'affiliate_product');
  assert.equal(classifyOfferType('physical_stock'),'');
  assert.equal(requiresInventory('service'),false);
  assert.equal(requiresInventory('affiliate_product'),false);
  assert.equal(revenueRecognitionRule('affiliate_product').source,'confirmed_commission');
  assert.equal(COMMERCIAL_MODEL.affiliate_gmv_is_revenue,false);
});

test('compliance gate blocks missing supplier identity',()=>{
  const r=evaluateCommercialCompliance({terms_published:true,privacy_published:true,refund_policy_published:true,service_delivery_policy_published:true,affiliate_disclosure_published:true});
  assert.equal(r.ready,false);
  assert.ok(r.blockers.includes('supplier_legal_name_missing'));
  assert.ok(r.blockers.includes('support_channel_missing'));
});
test('service activation requires production payment and real operator identity',()=>{
  const base={ACTIVE_OFFER_TYPE:'service',OFFER_SELECTION_APPROVED:'true',SUPPLIER_LEGAL_NAME:'Empresa X',SUPPLIER_TAX_ID:'00.000.000/0000-00',SUPPLIER_ADDRESS:'Endereco',SUPPORT_CHANNEL:'support@example.com',SERVICE_DELIVERY_MODE:'digital',PAYMENT_PROVIDER:'asaas',PAYMENT_MERCHANT_IDENTITY_VERIFIED:'true',ASAAS_API_KEY:'key',ASAAS_WEBHOOK_TOKEN:'token'};
  assert.equal(evaluateActivationReadiness({...base,ASAAS_ENV:'sandbox'}).ready,false);
  assert.equal(evaluateActivationReadiness({...base,ASAAS_ENV:'production'}).ready,true);
});

test('affiliate activation requires provider tracking and reviewed terms',()=>{
  const base={ACTIVE_OFFER_TYPE:'affiliate_product',OFFER_SELECTION_APPROVED:'true',SUPPLIER_LEGAL_NAME:'Empresa X',SUPPLIER_TAX_ID:'00.000.000/0000-00',SUPPLIER_ADDRESS:'Endereco',SUPPORT_CHANNEL:'support@example.com',AFFILIATE_PROVIDER:'network',AFFILIATE_WEBHOOK_URL:'https://affiliate.example/webhook',AFFILIATE_WEBHOOK_TOKEN:'token',AFFILIATE_TERMS_REVIEWED:'true',AFFILIATE_TERMS_VERSION:'v1',AFFILIATE_ATTRIBUTION_WINDOW_DAYS:'30',AFFILIATE_COMMISSION_BPS:'1000',AFFILIATE_PAYOUT_DELAY_DAYS:'30',AFFILIATE_SELF_REFERRAL_POLICY:'blocked',AFFILIATE_REFUND_REVERSAL_READY:'true',AFFILIATE_CHARGEBACK_REVERSAL_READY:'true',AFFILIATE_IDEMPOTENCY_READY:'true',AFFILIATE_PROVIDER_CONFIRMATION_READY:'true',AFFILIATE_DISCLOSURE_URL:'https://zevanory.api.br/afiliados',AFFILIATE_PRIVACY_URL:'https://zevanory.api.br/politica-de-privacidade'};
  assert.equal(evaluateActivationReadiness(base).ready,false);
  const ready=evaluateActivationReadiness({...base,AFFILIATE_TRACKING_READY:'true'});
  assert.equal(ready.ready,true);
  assert.equal(ready.inventory_required,false);
});