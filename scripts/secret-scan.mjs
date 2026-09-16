import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(Boolean);
const patterns=[
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:sk|rk|pk)_(?:live|prod)_[A-Za-z0-9]{16,}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/i,
];
const findings=[];
for(const file of files){
  let text=''; try{text=readFileSync(file,'utf8');}catch{findings.push({file,pattern:'unreadable_file'});continue;}
  for(const pattern of patterns) if(pattern.test(text)) findings.push({file,pattern:String(pattern)});
}
if(findings.length){console.error(JSON.stringify({ok:false,findings},null,2));process.exit(1);}
console.log(JSON.stringify({ok:true,files_scanned:files.length,findings:0}));
