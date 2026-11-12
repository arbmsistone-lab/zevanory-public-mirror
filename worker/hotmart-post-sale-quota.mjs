// One row per UTC month: a single row lock covers BOTH daily and monthly counters.
// A reservation is consumed even if its response or the later email outcome is uncertain.
const ready=new WeakSet();
export async function ensureRestrictedQuota(sql){
 if(!sql?.query)throw Error('quota_ledger_unreadable');
 if(ready.has(sql))return;
 await sql.query(`create table if not exists zevanory_posvenda_cota (
  periodo text primary key, used integer not null check (used >= 0 and used <= 1200),
  dias jsonb not null check (jsonb_typeof(dias) = 'object'))`,[]);
 ready.add(sql);
}
const periods=now=>{const day=new Date(now).toISOString().slice(0,10);return {day,month:day.slice(0,7)};};
function validMonth(row,month){
 if(!row||row.periodo!==month||!Number.isSafeInteger(row.used)||row.used<0||row.used>1200||!row.dias||typeof row.dias!=='object'||Array.isArray(row.dias))return false;
 let sum=0;for(const [day,n]of Object.entries(row.dias)){if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day.slice(0,7)!==month||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day||!Number.isSafeInteger(n)||n<0||n>40)return false;sum+=n;}
 return sum===row.used;
}
export async function restrictedQuota(sql,now){
 try{
  await ensureRestrictedQuota(sql);const {day,month}=periods(now);
  const rows=await sql.query(`/*posvenda:quota-read*/ select periodo, used, dias from zevanory_posvenda_cota where periodo = $1`,[month]);
  if(!Array.isArray(rows)||rows.length>1||rows[0]&&!validMonth(rows[0],month))throw Error('shape');
  return {restricted:true,used:rows[0]?.dias[day]??0,dailyLimit:40,monthlyUsed:rows[0]?.used??0,monthlyLimit:1200,day,month};
 }catch{throw Error('quota_ledger_unreadable');}
}
export async function reserveRestrictedQuota(sql,now){
 try{
  const q=await restrictedQuota(sql,now);
  // No separate daily increment: neither counter advances unless BOTH limits permit it.
  const rows=await sql.query(`/*posvenda:quota-reserve*/ insert into zevanory_posvenda_cota (periodo, used, dias)
   values ($1, 1, jsonb_build_object($2::text, 1))
   on conflict (periodo) do update set used = zevanory_posvenda_cota.used + 1,
    dias = jsonb_set(zevanory_posvenda_cota.dias, array[$2::text], to_jsonb(coalesce((zevanory_posvenda_cota.dias ->> $2::text)::integer, 0) + 1))
   where zevanory_posvenda_cota.used < $3
    and coalesce((zevanory_posvenda_cota.dias ->> $2::text)::integer, 0) < $4
   returning periodo, used, dias`,[q.month,q.day,q.monthlyLimit,q.dailyLimit]);
  if(!Array.isArray(rows)||rows.length>1||rows[0]&&!validMonth(rows[0],q.month))throw Error('shape');
  return rows.length===1;
 }catch{throw Error('quota_ledger_unreadable');}
}
