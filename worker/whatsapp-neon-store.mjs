const MAX_LIST=1000;
const TABLES=Object.freeze({
 stages:"whatsapp_stage_events",
 observations:"whatsapp_observations",
 evidence:"whatsapp_evidence",
 history:"whatsapp_history"
});
const STORE_CACHE=new Map();

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
 const ddl=Object.values(TABLES).map(table=>
  "create table if not exists "+table+" (\n"+
  " store_key text primary key,\n"+
  " store_value text not null,\n"+
  " expires_at timestamptz null,\n"+
  " updated_at timestamptz not null default now()\n"+
  ");\n"+
  "create index if not exists "+table+"_expires_at_idx on "+table+"(expires_at) where expires_at is not null;\n"+
  "create index if not exists "+table+"_updated_at_idx on "+table+"(updated_at desc);"
 ).join("\n");
 const ready=()=>readyPromise ||= sql.query(ddl);
 return Object.freeze({
  async put(key,value,options={}){
   await ready(); const table=tableForKey(key);
   const ttl=Math.max(0,Math.floor(Number(options?.expirationTtl||0)));
   await sql.query(
    "insert into "+table+"(store_key,store_value,expires_at,updated_at) "+
    "values($1,$2,case when $3::int>0 then now()+($3::int * interval '1 second') else null end,now()) "+
    "on conflict(store_key) do update set store_value=excluded.store_value,expires_at=excluded.expires_at,updated_at=now()",
    [String(key),String(value),ttl]);
  },
  async get(key,options={}){
   await ready(); const table=tableForKey(key);
   const rows=await sql.query("select store_value from "+table+" where store_key=$1 and (expires_at is null or expires_at>now()) limit 1",[String(key)]);
   const value=rows?.[0]?.store_value??null, json=options==="json"||options?.type==="json";
   if(value==null||!json)return value; try{return JSON.parse(value)}catch{return null}
  },
  async list({prefix="",limit=MAX_LIST,cursor=""}={}){
   await ready(); const table=tableForKey(prefix), n=Math.max(1,Math.min(MAX_LIST,Number(limit)||MAX_LIST));
   const rows=await sql.query(
    "select store_key from "+table+" where left(store_key,length($1))=$1 "+
    "and (expires_at is null or expires_at>now()) and ($2='' or store_key>$2) "+
    "order by store_key asc limit $3",
    [String(prefix),String(cursor||""),n+1]);
   const complete=rows.length<=n,page=rows.slice(0,n);
   return {keys:page.map(r=>({name:String(r.store_key)})),list_complete:complete,cursor:complete||!page.length?undefined:String(page.at(-1).store_key)};
  },
  async cleanupExpired(){
   await ready(); const deleted={};
   for(const table of Object.values(TABLES)){
    const rows=await sql.query("delete from "+table+" where expires_at is not null and expires_at<=now() returning store_key");
    deleted[table]=Array.isArray(rows)?rows.length:0;
   }
   return deleted;
  }
 });
}

function readonlyLegacyStore(kv){
 return Object.freeze({
  async put(){},
  async get(key,options){ return kv?.get ? kv.get(key,options) : null; },
  async list(options){ return kv?.list ? kv.list(options) : {keys:[],list_complete:true}; },
  async cleanupExpired(){ return {}; }
 });
}

function withLegacyReadFallback(primary,legacy){
 if(!primary)return readonlyLegacyStore(legacy);
 return Object.freeze({
  async put(key,value,options){ return primary.put(key,value,options); },
  async get(key,options){
   const value=await primary.get(key,options);
   if(value!==null&&value!==undefined)return value;
   return legacy?.get ? legacy.get(key,options) : null;
  },
  async list(options={}){
   const [fresh,old]=await Promise.all([
    primary.list(options),
    legacy?.list ? legacy.list(options).catch(()=>({keys:[]})) : {keys:[]}
   ]);
   const names=new Map();
   for(const item of [...(fresh?.keys||[]),...(old?.keys||[])]) if(item?.name&&!names.has(item.name)) names.set(item.name,item);
   const limit=Math.max(1,Math.min(MAX_LIST,Number(options.limit)||MAX_LIST));
   const keys=[...names.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name))).slice(0,limit);
   return {keys,list_complete:true};
  },
  async cleanupExpired(){ return primary.cleanupExpired?.()||{}; }
 });
}

export function getWhatsappOpsStore(env={},sqlFactory){
 const databaseUrl=String(env?.DATABASE_URL||"").trim();
 const legacy=env?.ZEVANORY_PRIVATE_ARTIFACTS||null;
 if(!databaseUrl||typeof sqlFactory!=="function") return readonlyLegacyStore(legacy);
 let store=STORE_CACHE.get(databaseUrl);
 if(!store){
  store=withLegacyReadFallback(createWhatsappNeonStore(sqlFactory(databaseUrl)),legacy);
  STORE_CACHE.set(databaseUrl,store);
 }
 return store;
}

export function resetWhatsappOpsStoreMemoForTest(){ STORE_CACHE.clear(); }
