// Dedicated transport/authentication proof. Never import a sales or mail writer here.
export const HOTMART_TEST_PATH = '/api/webhooks/hotmart/teste';
export const HOTMART_TEST_KEY = 'zpc:hotmart:webhook:teste:v1';
const EVENTS = new Set(['PURCHASE_APPROVED','PURCHASE_COMPLETE','PURCHASE_REFUNDED','PURCHASE_CHARGEBACK','PURCHASE_CANCELED','PURCHASE_PROTEST','PURCHASE_EXPIRED','PURCHASE_DELAYED','PURCHASE_BILLET_PRINTED','PURCHASE_OUT_OF_SHOPPING_CART','SUBSCRIPTION_CANCELLATION']);
const json=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export function hotmartTokenValid(request,env){
 let cfg={};try{cfg=typeof env.CHANNEL_CREDENTIALS_JSON==='string'?JSON.parse(env.CHANNEL_CREDENTIALS_JSON):env.CHANNEL_CREDENTIALS_JSON||{};}catch{}
 const secret=String(env.HOTMART_HOTTOK||cfg.HOTMART_HOTTOK||'').trim();
 const a=new TextEncoder().encode(secret),b=new TextEncoder().encode(request.headers.get('x-hotmart-hottok')||'');
 if(a.length<16||a.length!==b.length)return false;
 let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export function validHotmartTestProof(v){
 return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')==='evento,hottok_valido,recebido_em,versao'&&
 EVENTS.has(v.evento)&&v.versao==='2.0.0'&&v.hottok_valido===true&&typeof v.recebido_em==='string'&&Number.isFinite(Date.parse(v.recebido_em));
}
export async function readHotmartPostback(kv){
 try{const raw=await kv.get(HOTMART_TEST_KEY);if(raw===null)return {status:'NÃO TESTADO',recebido_em:null};
 const v=JSON.parse(raw);if(!validHotmartTestProof(v))throw Error('shape');
 return {status:'TESTE_OFICIAL_RECEBIDO '+v.recebido_em,recebido_em:v.recebido_em,scope:'rota_dedicada; não certifica ingestão de venda'};
 }catch{return {status:'LEITURA_INCONCLUSIVA',recebido_em:null};}
}
export async function handleHotmartTestWebhook(request,env,{now=Date.now()}={}){
 if(new URL(request.url).pathname!==HOTMART_TEST_PATH)return json(404,{ok:false,error:'not_found'});
 if(request.method!=='POST')return json(405,{ok:false,error:'method_not_allowed'});
 if(!hotmartTokenValid(request,env))return json(401,{ok:false,error:'unauthorized'});
 let body;try{body=await request.json();}catch{return json(400,{ok:false,error:'invalid_json'});}
 if(!EVENTS.has(body?.event)||body?.version!=='2.0.0')return json(422,{ok:false,error:'invalid_hotmart_event'});
 const kv=env.ZEVANORY_PRIVATE_ARTIFACTS;
 if(!kv?.get||!kv?.put)return json(503,{ok:false,error:'proof_unavailable'});
 try{
  // An actual storage read failure is transient: provider replay can retry safely.
  // A corrupt prior proof can be replaced from this fresh authenticated event;
  // no sales, idempotency or mail state is derived from the old value.
  await kv.get(HOTMART_TEST_KEY);
  const proof={recebido_em:new Date(now).toISOString(),evento:body.event,versao:body.version,hottok_valido:true};
  await kv.put(HOTMART_TEST_KEY,JSON.stringify(proof),{expirationTtl:30*86400});
 }catch{return json(503,{ok:false,error:'proof_commit_failed'});}
 return json(200,{ok:true,test:true});
}
