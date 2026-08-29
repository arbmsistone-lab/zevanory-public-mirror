const base=String(process.env.PRODUCTION_BASE_URL||'https://zevanory.api.br').replace(/\/$/,'');
const requireReady=process.argv.includes('--require-ready');
const expected=String(process.env.EXPECTED_RELEASE_ID||'').trim();

async function read(path){
  const response=await fetch(base+path,{cache:'no-store',signal:AbortSignal.timeout(8000)});
  const text=await response.text();
  let body={}; try{body=JSON.parse(text)}catch{}
  return {response,body};
}

const [health,release,assurance,activation,config]=await Promise.all([
  read('/api/health'),read('/api/release'),read('/api/assurance'),
  read('/api/activation/readiness'),read('/api/config'),
]);

const technicalReady=health.response.ok&&health.body.ready===true&&
  assurance.response.ok&&assurance.body.provider_contracts?.valid===true&&
  activation.response.ok&&(!expected||release.body.release_id===expected);
const output={
  service:'ZEVANORY', base,
  technical_ready:technicalReady,
  release_id:release.body.release_id||null,
  activation_phase:activation.body.activation_phase||null,
  inputs_ready:activation.body.inputs_ready===true,
  commercial_enabled:config.body.commercial_enabled===true,
  external_inputs_remaining:Number(activation.body.external_inputs_remaining||0),
  missing:Array.isArray(activation.body.missing)?activation.body.missing:[],
};
console.log(JSON.stringify(output,null,2));

if(!technicalReady) process.exit(1);
if(requireReady&&activation.body.inputs_ready!==true) process.exit(2);
if(requireReady&&activation.body.activation_phase!=='ready_to_unlock'&&activation.body.activation_phase!=='live') process.exit(3);
