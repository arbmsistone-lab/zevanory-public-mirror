import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';import {killedMutation} from './helpers/f1-mutation.mjs';import * as mode from '../scripts/shorts-v2/voice-samples-mode.mjs';
const source=new URL('../scripts/shorts-v2/voice-samples-mode.mjs',import.meta.url),workflow=readTextNormalized(new URL('../.github/workflows/youtube-autonomous-short.yml',import.meta.url));
async function dry(m){assert.throws(()=>m.assertSamplesMode('amostras','false'),/dry_run/);assert.equal(m.assertSamplesMode('amostras','true'),undefined);}
test('Samples: explicit dry run required',()=>dry(mode));
test('Samples mutant: dry run guard removed',()=>killedMutation(source,[["slot!=='amostras'||dryRun!=='true'","slot!=='amostras'"]],dry));
async function isolated(m){assert.equal(m.validateSamplesWorkflow(workflow),true);assert.throws(()=>m.validateSamplesWorkflow(workflow+'\n        run: node scripts/channels/youtube-daily-short.mjs'),/isolation/);}
test('Samples: job excludes video uploads, crossposts and KV credentials/writes',()=>isolated(mode));
test('Samples mutant: publisher allowed in samples job',()=>killedMutation(source,[["/youtube-daily-short|short-crosspost|CLOUDFLARE|KV_NAMESPACE|YOUTUBE_|renderV2|publishShort/.test(samples)","false"]],isolated));
test('Samples: 403, 429 and billing errors stop without retries or provider fallback',async()=>{for(const status of [403,429,400]){let calls=0;await assert.rejects(()=>mode.sampleTts('texto','Kore','synthetic',{model:'gemini-3.8-flash-tts',freeTierConfirmed:true,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({error:{code:status,status:status===400?'BILLING_DISABLED':'PERMISSION_DENIED'}}),{status});}}),/GEMINI::/);assert.equal(calls,1);}});
