const PREFIX='zpc:posvenda:hotmart:cota:';
export async function restrictedQuota(kv,now){
 const day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7);
 const read=async period=>{try{const raw=await kv.get(PREFIX+period);if(raw===null)return 0;const v=JSON.parse(raw);if(!v||Object.keys(v).sort().join(',')!=='periodo,schema,used'||v.schema!==1||v.periodo!==period||!Number.isSafeInteger(v.used)||v.used<0)throw Error('shape');return v.used;}catch{throw Error('quota_ledger_unreadable');}};
 return {restricted:true,used:await read(day),dailyLimit:40,monthlyUsed:await read(month),monthlyLimit:1200,day,month};
}
export async function reserveRestrictedQuota(kv,now){
 const q=await restrictedQuota(kv,now);if(q.used>=q.dailyLimit||q.monthlyUsed>=q.monthlyLimit)return false;
 try{for(const [period,used] of [[q.day,q.used+1],[q.month,q.monthlyUsed+1]]){const value=JSON.stringify({schema:1,periodo:period,used});await kv.put(PREFIX+period,value,{expirationTtl:400*86400});const actual=await kv.get(PREFIX+period);if(actual!==value)throw Error('unconfirmed');}}catch{throw Error('quota_ledger_unreadable');}return true;
}
