import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const run=(...files)=>spawnSync(process.execPath,['--test',...files],{encoding:'utf8'}).status===0;
const social=readFileSync('src/socialPosting.mjs','utf8');
const channels=readFileSync('src/channelAdapters.mjs','utf8');
const outbound=readFileSync('src/outboundAdapters.mjs','utf8');
let pass=0;
for(let i=1;i<=20;i++){
  const ok=run('test/social-channel-closeout.test.mjs','test/outbound-adapters.test.mjs','test/public-channel-status.test.mjs','test/social-assets.test.mjs','test/meta-version.test.mjs')&&
    social.includes('creator_info/query')&&social.includes('SELF_ONLY')&&social.includes('x-restli-id')&&
    channels.includes("provider:'tiktok-content-posting-api'")&&channels.includes("provider:'linkedin-posts-api'")&&
    outbound.includes("'channel:tiktok'")&&outbound.includes("'channel:linkedin'")&&outbound.includes("'channel:affiliate'")&&
    outbound.includes('ensureGlobalGates(env,commercialGate)')&&outbound.includes('commercialGate=salesGate');
  if(!ok){console.error(`SOCIAL_CHANNEL_AUDIT_${i}=FAIL`);process.exit(1);}pass++;console.log(`SOCIAL_CHANNEL_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_SOCIAL_CHANNEL_CLOSEOUT_20X_PASS=${pass}/20`);
