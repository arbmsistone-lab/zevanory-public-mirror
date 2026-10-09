import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url),"utf8");
test("isolated schedule records only ISO timestamp and boolean status",()=>{
 assert.match(source,/controller\?\.cron === "15,45 \* \* \* \*"/);
 assert.match(source,/JSON\.stringify\(\{at:new Date\(\)\.toISOString\(\),ok:proof\.ok===true\}\)/);
 assert.match(source,/last_isolated_run: \{ at: evidence\.at, ok: evidence\.ok \}/);
 assert.match(source,/expirationTtl:7\*86400/);
});
