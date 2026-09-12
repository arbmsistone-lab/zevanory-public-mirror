import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const checks=[]; const add=(name,ok,detail='')=>checks.push({name,ok:Boolean(ok),detail});
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const provider=process.env.GITHUB_ACTIONS?'github':process.env.GITLAB_CI?'gitlab':process.env.CIRCLECI?'circleci':'operator';
const eventSha=process.env.GITHUB_SHA||process.env.CI_COMMIT_SHA||process.env.CIRCLE_SHA1||'';
const sha=url=>{try{return execFileSync('git',['ls-remote',url,'refs/heads/main'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']}).trim().split(/\s+/)[0]||'';}catch{return '';}};
if(provider==='operator'){
  const gh=sha('https://github.com/arbmsistone-lab/ZEVANORY.git'); const gl=sha('https://gitlab.com/arbm-sistone/ZEVANORY.git');
  add('code local=GitHub',gh===head,gh); add('code local=GitLab',gl===head,gl); add('live GitHub=GitLab=HEAD',gh===head&&gl===head,`${gh}|${gl}`);
}else{
  add(`${provider} event SHA=checkout`,eventSha===head,`${eventSha}|${head}`);
  add('GitHub CI integration configured',fs.existsSync('.github/workflows/quality.yml'));
  add('GitLab CI integration configured',fs.existsSync('.gitlab-ci.yml'));
  add('CircleCI integration configured',fs.existsSync('.circleci/config.yml'));
}
const get=async url=>{try{const r=await fetch(url,{redirect:'follow'});return {status:r.status,text:await r.text()};}catch(e){return {status:0,text:String(e)}}};
const primary=await get('https://zevanory.api.br/arbm-sist'); const mirror=await get('https://arbmsistone-lab.github.io/zevanory-public-mirror/arbm-sist/');
add('primary public host healthy',primary.status===200,String(primary.status)); add('independent public mirror healthy',mirror.status===200,String(mirror.status));
add('primary canonical correct',primary.text.includes('rel="canonical" href="https://zevanory.api.br/arbm-sist"')); add('mirror canonical points primary',mirror.text.includes('rel="canonical" href="https://zevanory.api.br/arbm-sist"'));
add('Cloudflare config portable',fs.existsSync('wrangler.jsonc')); add('Vercel config portable',fs.existsSync('vercel.json')); add('Netlify config portable',fs.existsSync('netlify.toml')); add('static public artifact portable',fs.existsSync('public/solucoes.html')&&fs.existsSync('public/arbm-sist.html'));
const fail=checks.filter(c=>!c.ok); checks.forEach((c,i)=>console.log(`${String(i+1).padStart(2,'0')} ${c.ok?'PASS':'FAIL'} ${c.name}${c.detail?` ${c.detail}`:''}`));
console.log(`NO_SINGLE_PROVIDER mode=${provider} total=${checks.length} pass=${checks.length-fail.length} fail=${fail.length}`); if(fail.length) process.exitCode=1;