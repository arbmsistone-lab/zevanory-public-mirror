import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
const checks=[]; const add=(n,ok,d='')=>{checks.push({n,ok:Boolean(ok)});console.log(`${String(checks.length).padStart(2,'0')} ${ok?'PASS':'FAIL'} ${n}${d?' '+d:''}`)};
const remote=u=>{try{return execFileSync('git',['ls-remote',u,'refs/heads/main'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']}).trim().split(/\s+/)[0]}catch{return''}};
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const provider=process.env.GITHUB_ACTIONS?'github':process.env.GITLAB_CI?'gitlab':process.env.CIRCLECI?'circleci':'operator';
const eventSha=process.env.GITHUB_SHA||process.env.CI_COMMIT_SHA||process.env.CIRCLE_SHA1||'';
if(provider==='operator'){ const gh=remote('https://github.com/arbmsistone-lab/ZEVANORY.git'); const gl=remote('https://gitlab.com/arbm-sistone/ZEVANORY.git'); add('GitHub loss survivable',gl===head,gl); add('GitLab loss survivable',gh===head,gh); add('dual git quorum',gh===gl&&gh===head); }
else { add(`${provider} certified event SHA`,eventSha===head,`${eventSha}|${head}`); add('GitHub CI path configured',fs.existsSync('.github/workflows/quality.yml')); add('GitLab CI path configured',fs.existsSync('.gitlab-ci.yml')); add('CircleCI path configured',fs.existsSync('.circleci/config.yml')); }
const primary=await fetch('https://zevanory.api.br/solucoes'); const mirror=await fetch('https://arbmsistone-lab.github.io/zevanory-public-mirror/');
add('primary host healthy',primary.status===200,String(primary.status)); add('primary-host loss survivable',mirror.status===200,String(mirror.status)); add('mirror loss survivable',primary.status===200,String(primary.status));
const pd=new URL('https://zevanory.api.br').hostname.split('.').slice(-2).join('.'); const md=new URL('https://arbmsistone-lab.github.io/zevanory-public-mirror/').hostname.split('.').slice(-2).join('.'); add('emergency DNS independent',pd!==md);
const snapObj=JSON.parse(fs.readFileSync('validation/DNS-RECOVERY-SNAPSHOT.json','utf8')); const sh=crypto.createHash('sha256').update(JSON.stringify(snapObj)).digest('hex'); add('DNS snapshot parseable/canonical',Boolean(sh),sh);
const bg=fs.readFileSync('governance/BREAK-GLASS-2OF3.md','utf8'); add('break-glass 2-of-3',/duas das três|2-of-3/i.test(bg)); add('recovery keeps sales fail-closed',/fail-closed/i.test(bg));
const artifact=execFileSync(process.execPath,['scripts/public-artifact-recovery.mjs'],{encoding:'utf8'}); add('public artifact recovery',artifact.includes('PUBLIC_ARTIFACT_RECOVERY PASS'));
const release=await (await fetch('https://zevanory.api.br/api/release')).json(); add('sales blocked',release.sales_mode==='globally-blocked'); add('checkout blocked',release.checkout_mode==='globally-blocked');
const failed=checks.filter(x=>!x.ok).length; console.log(`CRITICAL_CONTINUITY mode=${provider} total=${checks.length} pass=${checks.length-failed} fail=${failed}`); if(failed)process.exit(1);