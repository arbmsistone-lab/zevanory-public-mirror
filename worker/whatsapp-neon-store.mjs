const MAX_LIST=1000;
export function createWhatsappNeonStore(sql){
 if(!sql?.query)return null;
 let readyPromise=null;
 const ready=()=>readyPromise ||= sql.query(`create table if not exists whatsapp_operational_store (
  store_key text primary key,
  store_value text not null,
  expires_at timestamptz null,
  updated_at timestamptz not null default now()
 )`);
 return Object.freeze({
  async put(key,value,options={}){
   await ready();
   const ttl=Math.max(0,Math.floor(Number(options?.expirationTtl||0)));
   await sql.query(`insert into whatsapp_operational_store(store_key,store_value,expires_at,updated_at)
    values($1,$2,case when $3::int>0 then now()+($3::int * interval '1 second') else null end,now())
    on conflict(store_key) do update set store_value=excluded.store_value,expires_at=excluded.expires_at,updated_at=now()`,
    [String(key),String(value),ttl]);
  },
  async get(key,options={}){
   await ready();
   const rows=await sql.query(`select store_value from whatsapp_operational_store
    where store_key=$1 and (expires_at is null or expires_at>now()) limit 1`,[String(key)]);
   const value=rows?.[0]?.store_value??null;
   const json=options==="json"||options?.type==="json";
   if(value==null||!json)return value;
   try{return JSON.parse(value)}catch{return null}
  },
  async list({prefix="",limit=MAX_LIST,cursor=""}={}){
   await ready();
   const n=Math.max(1,Math.min(MAX_LIST,Number(limit)||MAX_LIST));
   const rows=await sql.query(`select store_key from whatsapp_operational_store
    where left(store_key,length($1))=$1
      and (expires_at is null or expires_at>now())
      and ($2='' or store_key>$2)
    order by store_key asc limit $3`,[String(prefix),String(cursor||""),n+1]);
   const complete=rows.length<=n,page=rows.slice(0,n);
   return {keys:page.map(r=>({name:String(r.store_key)})),list_complete:complete,cursor:complete||!page.length?undefined:String(page.at(-1).store_key)};
  }
 });
}
