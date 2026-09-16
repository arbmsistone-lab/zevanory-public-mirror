import { neon } from '@neondatabase/serverless';
import { probeChannelAuthorizations } from '../src/channelAuthorizationProbe.mjs';

if(new URL(process.env.PUBLIC_BASE_URL||'https://invalid.example').hostname!=='zevanory.api.br')throw new Error('zevanory_project_identity_required');
if(!process.env.DATABASE_URL)throw new Error('canonical_database_required');
const result=await probeChannelAuthorizations(neon(process.env.DATABASE_URL));
console.log(JSON.stringify(result,null,2));
process.exitCode=Object.values(result.fronts).every(x=>x.authorization_ready&&x.identity_ready&&x.capability_ready)?0:2;
