import test from "node:test";
import assert from "node:assert/strict";
import { alertOwnerNow, ESCALATION_RE } from "../worker/owner-alerts.mjs";

test("owner alert policy treats refunds and complaints as alertable, not ordinary human requests",async()=>{assert.match("quero reembolso",ESCALATION_RE);assert.match("vou reclamar no procon",ESCALATION_RE);assert.doesNotMatch("quero falar com humano",ESCALATION_RE);const out=await alertOwnerNow({}, {category:"ordinary_metric",channel:"blog",contact:"anon",excerpt:"alcance baixo",reason:"metric"});assert.deepEqual(out,{sent:false,reason:"category_not_alertable"});});
