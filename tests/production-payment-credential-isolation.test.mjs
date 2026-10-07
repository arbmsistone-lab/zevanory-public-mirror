import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source=readFileSync(new URL("../worker/cloudflare-worker.recovered.mjs",import.meta.url),"utf8");

test("production Mercado Pago checkout never selects the test binding",()=>{
  assert.match(source,/const providerToken = pilotSandbox \? String\(process\.env\.MERCADOPAGO_TEST_ACCESS_TOKEN \|\| ""\) : String\(process\.env\.MERCADOPAGO_ACCESS_TOKEN \|\| ""\)/);
  assert.match(source,/const pilotSandbox = Boolean\(pilot\?\.authorized\).*CERTIFICATION_PILOT_/);
  assert.match(source,/mercadopago_test.*MERCADOPAGO_TEST_ACCESS_TOKEN.*certificationOnly: true/);
  assert.match(source,/mercadopago"\) return handler16/);
  assert.match(source,/handler16[\s\S]{0,300}MERCADOPAGO_ACCESS_TOKEN[\s\S]{0,160}certificationOnly: false/);
});
