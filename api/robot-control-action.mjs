import {neon} from '@neondatabase/serverless';
import {safeBearerEqual} from '../src/security.mjs';
import {setAgentPaused} from '../src/agentControl.mjs';

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
  const action=String(req.body?.action||'').toLowerCase();
  if(!['pause','resume'].includes(action)) return json(res,400,{error:'control_action_invalid'});
  try{
    const sql=neon(process.env.DATABASE_URL);
    const control=await setAgentPaused(sql,{paused:action==='pause',reason:req.body?.reason||`operator_${action}`,operator:'operator'});
    return json(res,200,{accepted:true,action,control});
  }catch(error){return json(res,503,{error:'robot_control_action_failed',detail:String(error?.message||'').slice(0,240)});}
}
