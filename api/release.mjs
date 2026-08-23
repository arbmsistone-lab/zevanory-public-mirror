import { RELEASE } from '../src/release.mjs';

export default function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){
    res.statusCode=405;
    return res.end(JSON.stringify({error:'method_not_allowed'}));
  }
  res.statusCode=200;
  return res.end(JSON.stringify({
    release_id:RELEASE.id,
    sales_mode:RELEASE.salesMode,
    checkout_mode:RELEASE.checkoutMode,
    financial_mode:RELEASE.financialMode,
    required_routes:RELEASE.requiredRoutes,
  }));
}
