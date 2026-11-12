// Deterministic SQL fixture; the separate PostgreSQL laboratory validates the same SQL.
export function quotaSql(){
 const months=new Map();const calls=[];
 return {months,calls,query:async(text,p=[])=>{
  calls.push(text);if(text.startsWith('create table'))return [];
  if(text.includes('posvenda:quota-read'))return months.has(p[0])?[structuredClone(months.get(p[0]))]:[];
  if(text.includes('posvenda:quota-reserve')){
   const [month,day,monthly,daily]=p,old=months.get(month)||{periodo:month,used:0,dias:{}};
   const monthlyGuard=text.includes('zevanory_posvenda_cota.used < $3'),dailyGuard=text.includes('0) < $4');
   if(monthlyGuard&&old.used>=monthly||dailyGuard&&(old.dias[day]||0)>=daily)return [];
   const next={periodo:month,used:old.used+1,dias:{...old.dias,[day]:(old.dias[day]||0)+1}};months.set(month,next);return [structuredClone(next)];
  }throw Error('unexpected quota SQL');
 }};
}
