const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};

export function mercadoLivreOAuthCallbackReadiness(query={}){
  const code=String(query.code||'').trim();
  const error=String(query.error||'').trim();
  if(code||error) return {status:503,body:{provider:'mercado_livre',ready:false,error:'oauth_exchange_not_enabled'}};
  return {status:200,body:{provider:'mercado_livre',ready:false,callback_registered:true,authorization_enabled:false}};
}

export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET') return json(res,405,{error:'method_not_allowed'});
  const result=mercadoLivreOAuthCallbackReadiness(req.query||{});
  return json(res,result.status,result.body);
}
