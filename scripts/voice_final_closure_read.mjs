import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export async function readFinalClosure(fetchImpl=fetch){
 for(let attempt=1;attempt<=3;attempt++){
  const r=await fetchImpl('https://zevanory.api.br/api/voice/final-closure',{signal:AbortSignal.timeout(30000)});
  const raw=await r.text(),html=/^\s*</.test(raw)||/text\/html/i.test(r.headers.get('content-type')||'');
  if(r.status===503||html){if(attempt<3){await new Promise(resolve=>setTimeout(resolve,1500));continue;}throw Error(`final_closure_transient_exhausted:http_${r.status}:html_${html}`);}
  if(!r.ok)throw Error(`final_closure_http_${r.status}`);
  try{return JSON.parse(raw);}catch{throw Error('final_closure_invalid_json');}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{writeFileSync(process.argv[2]||'/tmp/closure.json',JSON.stringify(await readFinalClosure(),null,2));}
 catch(error){console.error('::error title=FINAL_CLOSURE::'+error.message);process.exitCode=1;}
}
