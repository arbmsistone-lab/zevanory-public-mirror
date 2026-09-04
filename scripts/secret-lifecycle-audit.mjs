import fs from 'node:fs';
import path from 'node:path';

const policy=JSON.parse(fs.readFileSync('config/secret-lifecycle.json','utf8'));
const now=new Date(process.env.SECURITY_LIFECYCLE_NOW||Date.now());
const day=86_400_000;
const failures=[];
const declared=new Map((policy.credentials||[]).map(item=>[item.name,item]));

const reviewed=new Date(policy.lastReviewedAt);
if(Number.isNaN(reviewed.getTime()))failures.push('review_invalid');
else if((now-reviewed)/day>Number(policy.reviewCadenceDays||0))failures.push('review_overdue');
if(policy.rules?.metadataOnly!==true)failures.push('metadata_only_required');
if(policy.rules?.neverStoreSecretMaterial!==true)failures.push('never_store_secret_material_required');

for(const [name,item] of declared){
  if(!/^[A-Z0-9_]+$/.test(name))failures.push(`invalid_name:${name}`);
  if(!item.owner)failures.push(`owner_missing:${name}`);
  if(item.rotationState==='age-unverified'){
    const due=new Date(item.rotationDueBy);
    if(Number.isNaN(due.getTime()))failures.push(`rotation_due_invalid:${name}`);
    else if(now>due)failures.push(`rotation_age_verification_overdue:${name}`);
  }else{
    const rotated=new Date(item.lastRotatedAt);
    if(Number.isNaN(rotated.getTime()))failures.push(`rotation_invalid:${name}`);
    else if((now-rotated)/day>Number(item.rotationMaxDays||0))failures.push(`rotation_overdue:${name}`);
  }
}
const discovered=new Set();
for(const root of ['src','api','scripts']){
  if(!fs.existsSync(root))continue;
  const stack=[root];
  while(stack.length){
    const current=stack.pop();
    for(const entry of fs.readdirSync(current,{withFileTypes:true})){
      const full=path.join(current,entry.name);
      if(entry.isDirectory()){if(entry.name!=='node_modules')stack.push(full);continue;}
      if(!entry.name.endsWith('.mjs'))continue;
      const text=fs.readFileSync(full,'utf8');
      for(const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)){
        const name=match[1];
        if(name==='VERCEL_GIT_COMMIT_SHA'||name==='VERCEL_ENV'||name==='VERCEL_GIT_COMMIT_REF'||name==='VERCEL_REGION')continue;
        if(/(?:TOKEN|SECRET|KEY|DATABASE_URL)$/.test(name))discovered.add(name);
      }
    }
  }
}
for(const name of discovered)if(!declared.has(name))failures.push(`unmanaged_secret_reference:${name}`);

const raw=JSON.stringify(policy);
if(/(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/.test(raw))failures.push('secret_material_detected');
const result={status:failures.length?'FAIL':'PASS',reviewedAt:policy.lastReviewedAt,declared:declared.size,discovered:[...discovered].sort(),failures};
console.log(JSON.stringify(result,null,2));
if(failures.length)process.exit(1);
