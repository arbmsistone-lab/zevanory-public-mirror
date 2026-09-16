import test from 'node:test';
import assert from 'node:assert/strict';
import { financialReadiness, readAsaasAccount, readMercadoPagoAccount, readFinancialAccounts } from '../src/financialAccountReadModel.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('financial readiness is read-only and never enables movement', () => {
  const state = financialReadiness({ ASAAS_API_KEY: 'a', MERCADOPAGO_ACCESS_TOKEN: 'm' });
  assert.equal(state.mode, 'read_only');
  assert.equal(state.movement_enabled, false);
  assert.equal(state.sales_gate_independent, true);
  assert.equal(state.asaas, true);
  assert.equal(state.mercadopago, true);
});

test('Asaas reader returns balance and paginated statement', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/finance/balance')) return response({ balance: 123.45 });
    return response({ hasMore: true, data: [{ id: 'txn_1', value: 100 }] });
  };
  const result = await readAsaasAccount({ env: { ASAAS_API_KEY: 'secret', ASAAS_ENV: 'production' }, fetchImpl, limit: 10, offset: 20 });
  assert.equal(result.balance, 123.45);
  assert.equal(result.statement.length, 1);
  assert.equal(result.pagination.has_more, true);
  assert.match(calls[0].options.headers.access_token, /secret/);
});

test('Mercado Pago reader exposes generated account-money reports without moving funds', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/config')) return response({ include_withdraw: true });
    return response([{ id: 7, file_name: 'settlement.csv', date_created: '2026-09-13T00:00:00Z' }]);
  };
  const result = await readMercadoPagoAccount({ env: { MERCADOPAGO_ACCESS_TOKEN: 'secret' }, fetchImpl });
  assert.equal(result.available, true);
  assert.equal(result.direct_balance_supported, false);
  assert.equal(result.balance_source, 'account_money_report');
  assert.equal(result.latest_reports[0].file_name, 'settlement.csv');
});

test('aggregate reader degrades per provider instead of failing the whole financial view', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('asaas.com')) throw new Error('asaas_down');
    if (String(url).endsWith('/config')) return response({});
    return response([]);
  };
  const result = await readFinancialAccounts({
    env: { ASAAS_API_KEY: 'a', MERCADOPAGO_ACCESS_TOKEN: 'm' }, fetchImpl,
  });
  assert.equal(result.mode, 'read_only');
  assert.equal(result.movement_enabled, false);
  assert.equal(result.providers[0].available, false);
  assert.equal(result.providers[1].available, true);
});
