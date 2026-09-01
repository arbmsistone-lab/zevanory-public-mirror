import {neon} from '@neondatabase/serverless';
import {safeBearerEqual} from '../src/security.mjs';
import {decideApproval} from '../src/agentControl.mjs';

const json=(res,status,body)=>{res.statusCode=status;return res.end(JSON.stringify(body));};
export default async function handler(req,res){
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
  const expected=String(process.env.OPERATOR_TOKEN||'');
  const provided=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(!safeBearerEqual(expected,provided)) return json(res,401,{error:'operator_auth_required'});
  if(!process.env.DATABASE_URL) return json(res,503,{error:'robot_control_storage_unavailable'});
  const approvalId=String(req.body?.approval_id||'');
  const decision=String(req.body?.decision||'').toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)||!['approved','rejected'].includes(decision)) return json(res,400,{error:'approval_request_invalid'});
  try{
    const sql=neon(process.env.DATABASE_URL);
    const approval=await decideApproval(sql,{approvalId,decision,reason:req.body?.reason||'operator_decision',operator:'operator'});
    return json(res,200,{accepted:true,approval});
  }catch(error){return json(res,409,{error:'approval_decision_failed',detail:String(error?.message||'').slice(0,240)});}
}
