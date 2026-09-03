import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const root=new URL('../',import.meta.url);const t=(p)=>readFileSync(new URL(p,root),'utf8');
const run=()=>spawnSync(process.execPath,['--test','test/channel-identity-preflight.test.mjs','test/channel-readiness.test.mjs','test/meta-webhook.test.mjs'],{cwd:root,encoding:'utf8'}).status===0;
const module=t('src/channelIdentityPreflight.mjs'),channels=t('src/channelAdapters.mjs'),meta=t('src/http/webhookMeta.mjs'),env=t('.env.example'),evidence=t('evidence/EG-0066-channel-identity-preflight.md');
let pass=0;
for(let i=1;i<=20;i++){
  const ok=run()&&module.includes('558892340423')===false&&module.includes('PROJECT.officialWhatsappE164')&&module.includes('UCMl8-SxMVv77S2tz2H63P3A')&&module.includes("toUpperCase()==='ZEVANORY'")&&module.includes("toLowerCase()==='zevanory_'")&&
    channels.includes('META_WHATSAPP_IDENTITY_VERIFIED')&&channels.includes('META_FACEBOOK_IDENTITY_VERIFIED')&&channels.includes('META_INSTAGRAM_IDENTITY_VERIFIED')&&channels.includes('YOUTUBE_IDENTITY_VERIFIED')&&
    meta.includes('resolveMetaVerifyToken(process.env)')&&env.includes('META_VERIFY_TOKEN=')&&!env.includes('META_WEBHOOK_VERIFY_TOKEN=')&&
    evidence.includes('Meta official WhatsApp Business Platform')&&evidence.includes('Google YouTube Data API')&&evidence.includes('TikTok Content Posting API')&&evidence.includes('Global commercial gates remain independent and closed');
  if(!ok){console.error(`CHANNEL_IDENTITY_AUDIT_${i}=FAIL`);process.exit(1);}pass++;console.log(`CHANNEL_IDENTITY_AUDIT_${i}=PASS`);
}
console.log(`AUDIT_CHANNEL_IDENTITY_20X_PASS=${pass}/20`);
