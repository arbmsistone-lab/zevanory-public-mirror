export function controlCoreStoreMode(){
  return {
    primary:"immutable-github-actions-and-runtime",
    cache:"cloudflare-kv-best-effort",
    fail_closed:true,
    zero_spend:true
  };
}

export async function coreStoreAvailable(){
  return true;
}

export async function readCoreState(){
  return null;
}

export async function writeCoreState(){
  throw new Error("direct_control_core_store_write_disabled_use_evidence_pipeline");
}

export async function appendCoreEvent(){
  throw new Error("direct_control_core_event_write_disabled_use_evidence_pipeline");
}

export async function readIdempotency(){
  return null;
}

export async function writeIdempotency(){
  throw new Error("direct_idempotency_write_disabled_use_command_executor");
}
