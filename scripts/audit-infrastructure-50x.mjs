import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const checks=[];
const add=(name,ok,detail='')=>checks.push({name,ok:Boolean(ok),detail:String(detail||'')});
const cmd=(bin,args=[])=>{try{return execFileSync(bin,args,{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}).trim();}catch{return '';}};
const read=(p)=>{try{return fs.readFileSync(p,'utf8');}catch{return '';}};
const get=async(url,redirect='follow')=>{try{const r=await fetch(url,{redirect,signal:AbortSignal.timeout(15000)});return {status:r.status,text:await r.text(),headers:r.headers,location:r.headers.get('location')||''};}catch(e){return {status:0,text:String(e),headers:new Headers(),location:''};}};

const head=cmd('git',['rev-parse','HEAD']);
const origin=cmd('git',['ls-remote','https://github.com/arbmsistone-lab/ZEVANORY.git','refs/heads/main']).split(/\s+/)[0]||'';
const gitlab=cmd('git',['ls-remote','https://gitlab.com/arbm-sistone/ZEVANORY.git','refs/heads/main']).split(/\s+/)[0]||'';
const dirty=cmd('git',['status','--porcelain']);
const triggerSha=String(process.env.CIRCLE_SHA1||process.env.GITHUB_SHA||process.env.CI_COMMIT_SHA||head).trim();
const releaseParityDelegated=Boolean(process.env.CIRCLECI)&&gitlab==='';
add('01 local equals audited CI trigger SHA',head===triggerSha,head+'|'+triggerSha);
add('02 local equals GitLab main or authenticated release parity is delegated',gitlab!==''?head===gitlab:releaseParityDelegated,gitlab?head+'|'+gitlab:'delegated_to_authenticated_release_orchestrator');
add('03 GitHub equals GitLab or authenticated release parity is delegated',gitlab!==''?origin!==''&&origin===gitlab:releaseParityDelegated,gitlab?origin+'|'+gitlab:'delegated_to_authenticated_release_orchestrator');
add('04 worktree clean',dirty==='',dirty);
add('05 Cloudflare config present',fs.existsSync('wrangler.jsonc'));
add('06 Vercel config present',fs.existsSync('vercel.json'));
add('07 Netlify config present',fs.existsSync('netlify.toml'));
add('08 GitHub CI present',fs.existsSync('.github/workflows/quality.yml'));
add('09 GitLab CI present',fs.existsSync('.gitlab-ci.yml'));
add('10 CircleCI present',fs.existsSync('.circleci/config.yml'));

const wrangler=read('wrangler.jsonc'), vercel=read('vercel.json'), netlify=read('netlify.toml');
add('11 Cloudflare observability enabled',/"observability"\s*:\s*\{\s*"enabled"\s*:\s*true/.test(wrangler));
add('12 Cloudflare AI binding configured',/"ai"\s*:\s*\{\s*"binding"\s*:\s*"AI"/.test(wrangler));
add('13 Cloudflare KV binding configured',/ZEVANORY_PRIVATE_ARTIFACTS/.test(wrangler));
add('14 Cloudflare static assets binding configured',/"binding"\s*:\s*"ASSETS"/.test(wrangler));
add('15 canonical creative route owned by Cloudflare',/zevanory\.api\.br\/\*/.test(wrangler));
add('16 Vercel strict CSP configured',/Content-Security-Policy/.test(vercel)&&!/unsafe-inline|unsafe-eval/.test(vercel));
add('17 Vercel HSTS configured',/Strict-Transport-Security/.test(vercel));
add('18 Netlify standby is independently configured',netlify.length>0&&!/zevanory-site\.vercel\.app/.test(netlify));
add('19 public artifact recovery script present',fs.existsSync('scripts/public-artifact-recovery.mjs'));
add('20 DNS recovery script present',fs.existsSync('scripts/build-dns-recovery-snapshot.mjs'));
add('21 provider chaos drill present',fs.existsSync('scripts/chaos-provider-drill.mjs'));
add('22 critical continuity audit present',fs.existsSync('scripts/audit-critical-continuity.mjs'));
add('23 no-single-provider audit present',fs.existsSync('scripts/audit-no-single-provider.mjs'));
add('24 security 10x audit present',fs.existsSync('scripts/audit-security-10x.mjs'));
add('25 production 20x audit present',fs.existsSync('scripts/audit-production-20x.mjs'));

const canonical=await get('https://zevanory.api.br/criativos');
const edge=await get('https://edge.zevanory.api.br/criativos');
const mirror=await get('https://arbmsistone-lab.github.io/zevanory-public-mirror/arbm-sist/');
const legacy=await get('https://zevanory-site.vercel.app/criativos','manual');
const health=await get('https://zevanory.api.br/api/health');
const status=await get('https://zevanory.api.br/api/status');
const closure=await get('https://zevanory.api.br/api/config?view=closure_status');
add('26 canonical creative center HTTP 200',canonical.status===200,canonical.status);
add('27 independent edge creative center HTTP 200',edge.status===200,edge.status);
add('28 independent public mirror HTTP 200',mirror.status===200,mirror.status);
add('29 legacy Vercel URL redirects permanently',legacy.status===308,legacy.status);
add('30 legacy redirect targets canonical',legacy.location==='https://zevanory.api.br/criativos',legacy.location);
add('31 health endpoint HTTP 200',health.status===200,health.status);
add('32 status endpoint HTTP 200',status.status===200,status.status);
add('33 closure endpoint HTTP 200',closure.status===200,closure.status);

add('34 CSP live and strict',/default-src 'self'/.test(canonical.headers.get('content-security-policy')||'')&&!/unsafe-inline|unsafe-eval/.test(canonical.headers.get('content-security-policy')||''));
add('35 HSTS live',/max-age=63072000/.test(canonical.headers.get('strict-transport-security')||''));
add('36 nosniff live',(canonical.headers.get('x-content-type-options')||'').toLowerCase()==='nosniff');
add('37 clickjacking blocked',(canonical.headers.get('x-frame-options')||'').toUpperCase()==='DENY');
add('38 referrer policy hardened',(canonical.headers.get('referrer-policy')||'')==='strict-origin-when-cross-origin');
add('39 permissions policy hardened',/camera=\(\), microphone=\(\), geolocation=\(\)/.test(canonical.headers.get('permissions-policy')||''));
let healthJson={}, closureJson={};
try{healthJson=JSON.parse(health.text);}catch{}
try{closureJson=JSON.parse(closure.text);}catch{}
const controls=healthJson.commercial_controls||{};
const runtime=(()=>{try{return JSON.parse(status.text).runtime||{};}catch{return {};}})();
add('40 health reports ready',healthJson.ready===true,healthJson.ready);
add('41 all commercial controls disabled',controls.enabled===0&&controls.total===5,`${controls.enabled}/${controls.total}`);
add('42 runtime sales globally blocked',runtime.sales==='globally-blocked',runtime.sales);
add('43 runtime checkout globally blocked',runtime.checkout==='globally-blocked',runtime.checkout);
add('44 runtime WhatsApp disabled',runtime.whatsapp==='disabled',runtime.whatsapp);
add('45 runtime financial disabled',runtime.financial==='disabled',runtime.financial);
add('46 closure commercial flag false',closureJson.commercial_enabled===false,closureJson.commercial_enabled);
add('47 distribution has exactly 12 active fronts',closureJson.distribution?.total_fronts===12,closureJson.distribution?.total_fronts);
add('48 all 12 fronts configured',closureJson.distribution?.configured_fronts===12,closureJson.distribution?.configured_fronts);
add('49 all 9 fronts automation-ready',closureJson.distribution?.automation_ready_fronts===9,closureJson.distribution?.automation_ready_fronts);
const exposed=/access[_-]?token|client[_-]?secret|api[_-]?key|password/i.test(closure.text);
add('50 closure surface exposes no credential fields',!exposed);

const failed=checks.filter(x=>!x.ok);
for(const c of checks) console.log(`${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?` :: ${c.detail}`:''}`);
console.log(`INFRASTRUCTURE_50X total=${checks.length} pass=${checks.length-failed.length} fail=${failed.length}`);
if(checks.length!==50) {console.error(`AUDIT_DEFINITION_ERROR expected=50 actual=${checks.length}`);process.exitCode=2;}
else if(failed.length) process.exitCode=1;
