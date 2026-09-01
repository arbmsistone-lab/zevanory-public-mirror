import { verifyExternalChannelIdentities } from '../src/channelIdentityPreflight.mjs';

const result=await verifyExternalChannelIdentities();
const summary=Object.fromEntries(Object.entries(result).map(([channel,state])=>[channel,{attempted:state.attempted,verified:state.verified,reason:state.reason}]));
const verified=Object.values(result).filter((x)=>x.verified).length;
const attempted=Object.values(result).filter((x)=>x.attempted).length;
console.log(JSON.stringify({service:'ZEVANORY',mode:'read_only_identity_preflight',attempted,verified,channels:summary},null,2));
if(process.argv.includes('--strict')&&Object.values(result).some((x)=>x.attempted&&!x.verified))process.exit(2);
