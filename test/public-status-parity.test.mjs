import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCommercialChannelReadinessSummary } from '../src/publicChannelStatus.mjs';
import { runtimeReleaseModes } from '../src/release.mjs';

const closed={SALE_GLOBALLY_ENABLED:'false',PRE_SALE_GATES_APPROVED:'false',CHECKOUT_ENABLED:'true',FINANCIAL_EVENTS_ENABLED:'true'};

test('public commercial channel status is canonical across runtime-local credentials',()=>{
  const vercel={...closed,WHATSAPP_SALES_ENABLED:'true',META_ACCESS_TOKEN:'x',INSTAGRAM_BUSINESS_ACCOUNT_ID:'1'};
  const edge={...closed,WHATSAPP_SALES_ENABLED:'false',NUVEMSHOP_CSV_FALLBACK_VERIFIED:'true'};
  assert.deepEqual(publicCommercialChannelReadinessSummary(vercel),publicCommercialChannelReadinessSummary(edge));
});

test('whatsapp is effectively disabled while global sales gate is closed',()=>{
  const modes=runtimeReleaseModes({...closed,WHATSAPP_SALES_ENABLED:'true'});
  assert.equal(modes.salesMode,'globally-blocked');
  assert.equal(modes.whatsappMode,'disabled');
});
