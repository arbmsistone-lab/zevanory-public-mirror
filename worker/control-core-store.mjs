import { controlCoreDatabaseQuery } from "./cloudflare-worker.recovered.mjs";

let schemaReady=false;

function clean(value,max=500){
  return String(value??"").trim().slice(0,max);
}
function dbUrl(env){
  return clean(env?.DATABASE_URL,8000);
}
async function query(env,text,params=[]){
  const url=dbUrl(env);
  if(!url) throw new Error("control_core_database_url_missing");
  return controlCoreDatabaseQuery(url,text,params);
}
async function ensureSchema(env){
  if(schemaReady) return true;
  await query(env,`
    create table if not exists zevanory_control_core_state (
      state_key text primary key,
      payload jsonb not null,
      release_sha text,
      decision_hash text,
      updated_at timestamptz not null default now()
    )`);
  await query(env,`
    create table if not exists zevanory_control_core_events (
      event_hash text primary key,
      event_type text not null,
      command text,
      release_sha text,
      payload jsonb not null,
      observed_at timestamptz not null,
      created_at timestamptz not null default now()
    )`);
  await query(env,`
    create table if not exists zevanory_control_core_idempotency (
      key_hash text primary key,
      command text not null,
      release_sha text,
      http_status integer not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    )`);
  schemaReady=true;
  return true;
}

export function controlCoreStoreMode(){
  return {
    primary:"postgres-durable-ledger",
    cache:"cloudflare-kv-best-effort",
    fail_closed:true,
    zero_spend:true
  };
}
export async function coreStoreAvailable(env){
  try{
    await ensureSchema(env);
    const rows=await query(env,"select 1::int as ok");
    return Number(rows?.[0]?.ok||0)===1;
  }catch{return false;}
}
export async function readCoreState(env,stateKey){
  await ensureSchema(env);
  const rows=await query(env,
    "select payload from zevanory_control_core_state where state_key=$1 limit 1",
    [clean(stateKey,200)]
  );
  return rows?.[0]?.payload||null;
}
export async function writeCoreState(env,stateKey,payload,{releaseSha=null,decisionHash=null}={}){
  await ensureSchema(env);
  const rows=await query(env,`
    insert into zevanory_control_core_state(state_key,payload,release_sha,decision_hash,updated_at)
    values($1,$2::jsonb,$3,$4,now())
    on conflict(state_key) do update set
      payload=excluded.payload,
      release_sha=excluded.release_sha,
      decision_hash=excluded.decision_hash,
      updated_at=now()
    returning state_key,updated_at
  `,[clean(stateKey,200),JSON.stringify(payload),releaseSha,decisionHash]);
  return rows?.[0]||null;
}
export async function appendCoreEvent(env,eventHash,event){
  await ensureSchema(env);
  const observed=clean(event?.observed_at||event?.requested_at||new Date().toISOString(),64);
  const rows=await query(env,`
    insert into zevanory_control_core_events(event_hash,event_type,command,release_sha,payload,observed_at)
    values($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
    on conflict(event_hash) do nothing
    returning event_hash
  `,[
    clean(eventHash,64),
    clean(event?.type||"CONTROL_CORE_EVENT",120),
    clean(event?.command||"",120)||null,
    clean(event?.release_sha||"",64)||null,
    JSON.stringify(event),
    observed
  ]);
  return rows?.[0]||{event_hash:clean(eventHash,64),idempotent:true};
}
export async function readIdempotency(env,keyHash){
  await ensureSchema(env);
  const rows=await query(env,
    "select http_status,payload from zevanory_control_core_idempotency where key_hash=$1 limit 1",
    [clean(keyHash,64)]
  );
  if(!rows?.[0]) return null;
  return {...(rows[0].payload||{}),http_status:Number(rows[0].http_status||200)};
}
export async function writeIdempotency(env,keyHash,{command,releaseSha,httpStatus,payload}){
  await ensureSchema(env);
  await query(env,`
    insert into zevanory_control_core_idempotency(key_hash,command,release_sha,http_status,payload)
    values($1,$2,$3,$4,$5::jsonb)
    on conflict(key_hash) do nothing
  `,[
    clean(keyHash,64),
    clean(command,120),
    clean(releaseSha||"",64)||null,
    Number(httpStatus||200),
    JSON.stringify(payload)
  ]);
  return true;
}

export async function listCoreEvents(env,limit=30){
  await ensureSchema(env);
  const n=Math.max(1,Math.min(Number(limit)||30,100));
  const rows=await query(env,`
    select payload
    from zevanory_control_core_events
    order by observed_at desc
    limit $1
  `,[n]);
  return (rows||[]).map(row=>row.payload).filter(Boolean);
}
