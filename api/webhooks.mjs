import asaasHandler from '../src/http/webhookAsaas.mjs';
import mercadoPagoHandler from '../src/http/webhookMercadoPago.mjs';
import resendHandler from '../src/http/webhookResend.mjs';
import metaHandler from '../src/http/webhookMeta.mjs';
import mercadoLivreHandler from '../src/http/webhookMercadoLivre.mjs';
import mercadoLivreOAuthHandler from '../src/http/oauthMercadoLivre.mjs';

export const config={api:{bodyParser:false}};
const WEBHOOK_MAX_BYTES=256*1024;

const providerFrom=(req)=>{
  const direct=String(req.query?.provider||'').toLowerCase();
  if(direct) return direct;
  try{return String(new URL(req.url||'', 'https://zevanory.api.br').searchParams.get('provider')||'').toLowerCase();}catch{return '';}
};

const readRawBody=async(req)=>{
  const declared=Number(req.headers?.['content-length']||0);
  if(Number.isFinite(declared)&&declared>WEBHOOK_MAX_BYTES) throw new Error('payload_too_large');
  const chunks=[]; let total=0;
  for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=b.length;if(total>WEBHOOK_MAX_BYTES)throw new Error('payload_too_large');chunks.push(b);}
  return Buffer.concat(chunks,total);
};

export default async function handler(req,res){
  const provider=providerFrom(req);
  if(!['asaas','mercadopago','resend','meta','mercadolivre','mercadolivre_oauth'].includes(provider)){
    res.setHeader('content-type','application/json; charset=utf-8');
    res.statusCode=400;
    return res.end(JSON.stringify({error:'webhook_provider_invalid',accepted:false}));
  }
  let raw;
  try{raw=await readRawBody(req);}catch(error){
    res.setHeader('content-type','application/json; charset=utf-8');
    const tooLarge=String(error?.message||'')==='payload_too_large';
    res.statusCode=tooLarge?413:400;
    return res.end(JSON.stringify({error:tooLarge?'payload_too_large':'invalid_body',accepted:false}));
  }
  req.rawBody=raw;
  if(provider!=='resend'){
    try{req.parsedBody=raw.length?JSON.parse(raw.toString('utf8')):{};}catch{
      res.setHeader('content-type','application/json; charset=utf-8');
      res.statusCode=400;
      return res.end(JSON.stringify({error:'invalid_json',accepted:false}));
    }
  }
  if(provider==='asaas') return asaasHandler(req,res);
  if(provider==='mercadopago') return mercadoPagoHandler(req,res);
  if(provider==='meta') return metaHandler(req,res);
  if(provider==='mercadolivre') return mercadoLivreHandler(req,res);
  if(provider==='mercadolivre_oauth') return mercadoLivreOAuthHandler(req,res);
  return resendHandler(req,res);
}

