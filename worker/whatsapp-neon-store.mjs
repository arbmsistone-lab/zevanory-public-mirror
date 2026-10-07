const MAX_LIST=1000;
const TABLES=Object.freeze({
 stages:"whatsapp_stage_events",
 observations:"whatsapp_observations",
 evidence:"whatsapp_evidence",
 history:"whatsapp_history"
});
function tableForKey(key){
 const k=String(key||"");
 if(k.startsWith("whatsapp:instant:"))return TABLES.stages;
 if(k.startsWith("whatsapp:observation:"))return TABLES.observations;
 if(k.startsWith("whatsapp-e2e/"))return TABLES.evidence;
 if(k.startsWith("wa:conv:"))return TABLES.history;
 throw new Error("unsupported_whatsapp_operational_key");
}
export function createWhatsappNeonStore(sql){
 if(!sql?.query)return null;
 let readyPromise=null;
 const ready=()=>readyPromise ||= (async()=>{
  for(const table of Object.values(TABLES)){
   await sql.query(`create table if not exists ${table} (
    store_key text primary key,
    store_value text not null,
    expires_at timestamptz null,
    updated_at timestamptz not null default now()
   )`);
   await sql.query(`create index if not exists ${table}_expires_at_idx on ${table}(expires_at) where expires_at is not null`);
   await sql.query(`create index if not exists ${table}_updated_at_idx on ${table}(updated_at desc)`);
  }
 })();
 return Object.freeze({
  async put(key,value,options={}){
   await ready(); const table=tableForKey(key);
   const ttl=Math.max(0,Math.floor(Number(options?.expirationTtl||0)));
   await sql.query(`insert into ${table}(store_key,store_value,expires_at,updated_at)
    values($1,$2,case when $3::int>0 then now()+($3::int * interval '1 second') else null end,now())
    on conflict(store_key) do update set store_value=excluded.store_value,expires_at=excluded.expires_at,updated_at=now()`,
    [String(key),String(value),ttl]);
  },
  async get(key,options={}){
   await ready(); const table=tableForKey(key);
   const rows=await sql.query(`select store_value from ${table} where store_key=$1 and (expires_at is null or expires_at>now()) limit 1`,[String(key)]);
   const value=rows?.[0]?.store_value??null, json=options==="json"||options?.type==="json";
   if(value==null||!json)return value; try{return JSON.parse(value)}catch{return null}
  },
  async list({prefix="",limit=MAX_LIST,cursor=""}={}){
   await ready(); const table=tableForKey(prefix), n=Math.max(1,Math.min(MAX_LIST,Number(limit)||MAX_LIST));
   const rows=await sql.query(`select store_key from ${table}
    where left(store_key,length($1))=$1 and (expires_at is null or expires_at>now()) and ($2='' or store_key>$2)
    order by store_key asc limit $3`,[String(prefix),String(cursor||""),n+1]);
   const complete=rows.length<=n,page=rows.slice(0,n);
   return {keys:page.map(r=>({name:String(r.store_key)})),list_complete:complete,cursor:complete||!page.length?undefined:String(page.at(-1).store_key)};
  },
  async cleanupExpired(){
   await ready(); const deleted={};
   for(const table of Object.values(TABLES)){
    const rows=await sql.query(`delete from ${table} where expires_at is not null and expires_at<=now() returning store_key`);
    deleted[table]=Array.isArray(rows)?rows.length:0;
   }
   return deleted;
  }
 });
}
