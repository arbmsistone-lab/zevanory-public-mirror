import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const entry=readFileSync(new URL("../certification-worker.mjs",import.meta.url),"utf8");
const build=readFileSync(new URL("../scripts/deploy/prepare-certification-config.py",import.meta.url),"utf8");
const flow=readFileSync(new URL("../.github/workflows/mercadopago-combo-sandbox.yml",import.meta.url),"utf8");
const proof=readFileSync(new URL("../scripts/mercadopago_combo_sandbox.py",import.meta.url),"utf8");
test("certification runtime imports one canonical source, no public commerce and no cron",()=>{
 assert.match(entry,/import canonical from "\.\/worker\/cloudflare-worker\.compat\.mjs"/);
 assert.match(entry,/if\(!allowed\.has\(url\.pathname\)\)/);
 assert.match(entry,/SALE_GLOBALLY_ENABLED/);
 assert.match(entry,/MERCADOPAGO_ENV/);
 assert.match(entry,/async scheduled\(\)/);
 assert.doesNotMatch(entry,/https:\/\/vendas\.zevanory/);
});
test("no production storage/secrets/services and no implicit certification release",()=>{
 assert.match(build,/PRODUCTION_STORAGE_REUSE_DENIED/);
 assert.match(build,/routes":\[\]/);
 assert.match(build,/services/);
 assert.match(entry,/MERCADOPAGO_ACCESS_TOKEN/);
 assert.match(entry,/CERTIFICATION_DATABASE_URL/);
 assert.match(entry,/CERTIFICATION_D1/);
});
test("financial workflow uses only pinned isolated endpoint and approval",()=>{
 assert.match(flow,/CERTIFICATION_SANDBOX_URL/);
 assert.match(flow,/sandbox-financial-approved/);
 assert.match(flow,/github\.run_attempt == 1/);
 assert.match(proof,/ISOLATED_WORKER_ORIGIN_REQUIRED/);
 assert.match(proof,/workers\.dev/);
});
