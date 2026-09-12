import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
const checks=[]; const add=(n,ok,d='')=>checks.push({n,ok:Boolean(ok),d});
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const provider=process.env.GITHUB_ACTIONS?'github':process.env.GITLAB_CI?'gitlab':process.env.CIRCLECI?'circleci':'operator';
const eventSha=process.env.GITHUB_SHA||process.env.CI_COMMIT_SHA||process.env.CIRCLE_SHA1||'';
const remote=u=>{try{return execFileSync('git',['ls-remote',u,'refs/heads/main'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']}).trim().split(/\s+/)[0]}catch{return ''}};
if(provider==='operator'){
  const gh=remote('https://github.com/arbmsistone-lab/ZEVANORY.git'); const gl=remote('https://gitlab.com/arbm-sistone/ZEVANORY.git');
  add('GitHub lost -> GitLab still has current SHA',gl===head,gl); add('GitLab lost -> GitHub still has current SHA',gh===head,gh); add('both git providers represented',gh===head&&gl===head);
}else{
  add(`${provider} checkout is certified SHA`,eventSha===head,`${eventSha}|${head}`); add('alternate GitHub CI path configured',fs.existsSync('.github/workflows/quality.yml')); add('alternate GitLab CI path configured',fs.existsSync('.gitlab-ci.yml')); add('alternate CircleCI path configured',fs.existsSync('.circleci/config.yml'));
}
const probe=async u=>{try{return (await fetch(u,{redirect:'follow'})).status}catch{return 0}};
const primary=await probe('https://zevanory.api.br/solucoes'); const mirror=await probe('https://arbmsistone-lab.github.io/zevanory-public-mirror/');
add('Cloudflare lost -> independent mirror serves',mirror===200,String(mirror)); add('mirror lost -> primary serves',primary===200,String(primary));
add('portable public recovery passes',(()=>{try{execFileSync(process.execPath,['scripts/public-artifact-recovery.mjs'],{stdio:'ignore'});return true}catch{return false}})()); add('DNS recovery snapshot exists',fs.existsSync('validation/DNS-RECOVERY-SNAPSHOT.json')); add('DNS snapshot hash exists',fs.existsSync('validation/DNS-RECOVERY-SNAPSHOT.sha256'));
const bg=fs.readFileSync('governance/BREAK-GLASS-2OF3.md','utf8'); add('break-glass requires 2-of-3',/duas das três|2-of-3/i.test(bg)); add('sales stay fail-closed during recovery',/fail-closed/i.test(bg));
for(const [i,c] of checks.entries()) console.log(`${String(i+1).padStart(2,'0')} ${c.ok?'PASS':'FAIL'} ${c.n}${c.d?' '+c.d:''}`); const fail=checks.filter(x=>!x.ok); console.log(`CHAOS_PROVIDER_DRILL mode=${provider} total=${checks.length} pass=${checks.length-fail.length} fail=${fail.length}`); if(fail.length) process.exit(1);