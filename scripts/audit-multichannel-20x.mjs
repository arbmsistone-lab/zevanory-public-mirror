import fs from 'node:fs';
import { CHANNELS, channelReadiness } from '../src/channelAdapters.mjs';
import { CHANNEL_PROFILES, PROFESSIONAL_EMAIL } from '../src/channelProfiles.mjs';
const html=fs.readFileSync('public/index.html','utf8');
const robots=fs.readFileSync('public/robots.txt','utf8');
const sitemap=fs.readFileSync('public/sitemap.xml','utf8');
const checks=[
 ['12 distribution channels cataloged',Object.keys(CHANNELS).length===12],
 ['owned web present',!!CHANNELS.zevanory],
 ['whatsapp present',!!CHANNELS.whatsapp],
 ['email present',!!CHANNELS.email],
 ['instagram present',!!CHANNELS.instagram],
 ['facebook present',!!CHANNELS.facebook],
 ['tiktok present',!!CHANNELS.tiktok],
 ['youtube present',!!CHANNELS.youtube],
 ['linkedin present',!!CHANNELS.linkedin],
 ['google SEO present',!!CHANNELS.google],
 ['affiliate present',!!CHANNELS.affiliate], ['professional email domain',PROFESSIONAL_EMAIL.primary==='contato@zevanory.api.br'],
 ['email aliases defined',PROFESSIONAL_EMAIL.aliases.length===3],
 ['email auth DNS required',PROFESSIONAL_EMAIL.requiredDns.join(',')==='MX,SPF,DKIM,DMARC'],
 ['institutional profiles tracked',Object.values(CHANNEL_PROFILES).every(x=>x.url.includes('utm_campaign=zevanory_brand'))],
 ['canonical present',html.includes('rel="canonical" href="https://zevanory.api.br/"')],
 ['open graph present',html.includes('property="og:title"')&&html.includes('property="og:url"')],
 ['twitter card present',html.includes('name="twitter:card"')],
 ['schema.org organization present',html.includes('schema.org')&&html.includes('Organization')],
 ['robots and sitemap present',robots.includes('Sitemap: https://zevanory.api.br/sitemap.xml')&&sitemap.includes('https://zevanory.api.br/')],
];
let ok=0;
for(const [name,pass] of checks){console.log(`${pass?'APPROVED':'FAILED'} ${name}`); if(pass) ok++;}
console.log(`AUDIT_MULTICHANNEL_20X_${ok===20?'APPROVED':'FAILED'} units=20 approved=${ok} failed=${20-ok}`);
if(ok!==20) process.exit(1);
console.log('RUNTIME_EXTERNAL_CHANNELS='+JSON.stringify(channelReadiness({})));
