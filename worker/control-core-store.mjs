import { neon } from "@neondatabase/serverless";

const READY = new WeakMap();

function clean(value,max=500){
  return String(value??"").trim().slice(0,max);
}
function jsonText(value){
  return JSON.stringify(value??null);
}
function db(env){
  const url=clean(env?.DATABASE_URL,8000);
  if(!url) return null;
  return neon(url);
}
async function ensureSchema(sql){
  if(!sql) return false;
  if(READY.has(sql)) return true;
  await sql.query(`
    create table if not exists zevanory_control_core_state (
      state_key text primary key,
      payload jsonb not null,
      release_sha text,
      decision_hash text,
      updated_at timestamptz not null default now()
    )
  `,[]);
  await sql.query(`
    create table if not exists zevanory_control_core_events (
      event_hash text primary key,
      event_type text not null,
      command text,
      release_sha text,
      payload jsonb not null,
      observed_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `,[]);
  await sql.query(`
    create table if not exists zevanory_control_core_idempotency (
      key_hash text primary key,
      command text not null,
      release_sha text,
      http_status integer not null,
      payload jsonb not null,
      created_at timestamptz not null default now()
    )
  `,[]);
  READY.set(sql,true);
  return true;
}

export async function coreStoreAvailable(env){
  const sql=db(env);
  if(!sql) return false;
  try{
    await ensureSchema(sql);
    const rows=await sql.query("select 1 as ok",[]);
    return Number(rows?.[0]?.ok||0)===1;
  }catch{return false;}
}

export async function readCoreState(env,stateKey){
  const sql=db(env);
  if(!sql) return null;
  await ensureSchema(sql);
  const rows=await sql.query(
    "select payload from zevanory_control_core_state where state_key=$1 limit 1",
    [clean(stateKey,200)]
  );
  return rows?.[0]?.payload||null;
}

export async function writeCoreState(env,stateKey,payload,{releaseSha=null,decisionHash=null}={}){
  const sql=db(env);
  if(!sql) throw new Error("control_core_database_unavailable");
  await ensureSchema(sql);
  const rows=await sql.query(
    `insert into zevanory_control_core_state(state_key,payload,release_sha,decision_hash,updated_at)
     values($1,$2::jsonb,$3,$4,now())
     on conflict(state_key) do update set
       payload=excluded.payload,
       release_sha=excluded.release_sha,
       decision_hash=excluded.decision_hash,
       updated_at=now()
     returning state_key,updated_at`,
    [clean(stateKey,200),jsonText(payload),releaseSha,decisionHash]
  );
  return rows?.[0]||null;
}

export async function appendCoreEvent(env,eventHash,event){
  const sql=db(env);
  if(!sql) throw new Error("control_core_database_unavailable");
  await ensureSchema(sql);
  const rows=await sql.query(
    `insert into zevanory_control_core_events(event_hash,event_type,command,release_sha,payload,observed_at)
     values($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
     on conflict(event_hash) do nothing
     returning event_hash`,
    [
      clean(eventHash,64),
      clean(event?.type||"CONTROL_CORE_EVENT",120),
      clean(event?.command||"",120)||null,
      clean(event?.release_sha||"",64)||null,
      jsonText(event),
      clean(event?.observed_at||event?.requested_at||new Date().toISOString(),64)
    ]
  );
  return rows?.[0]||{event_hash:clean(eventHash,64),idempotent:true};
}

export async function readIdempotency(env,keyHash){
  const sql=db(env);
  if(!sql) return null;
  await ensureSchema(sql);
  const rows=await sql.query(
    "select http_status,payload from zevanory_control_core_idempotency where key_hash=$1 limit 1",
    [clean(keyHash,64)]
  );
  if(!rows?.[0]) return null;
  return {...(rows[0].payload||{}),http_status:Number(rows[0].http_status||200)};
}

export async function writeIdempotency(env,keyHash,{command,releaseSha,httpStatus,payload}){
  const sql=db(env);
  if(!sql) throw new Error("control_core_database_unavailable");
  await ensureSchema(sql);
  await sql.query(
    `insert into zevanory_control_core_idempotency(key_hash,command,release_sha,http_status,payload)
     values($1,$2,$3,$4,$5::jsonb)
     on conflict(key_hash) do nothing`,
    [clean(keyHash,64),clean(command,120),clean(releaseSha||"",64)||null,Number(httpStatus||200),jsonText(payload)]
  );
  return true;
}
