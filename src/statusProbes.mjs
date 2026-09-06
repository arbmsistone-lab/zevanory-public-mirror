import { neon } from '@neondatabase/serverless';
import { RELEASE } from './release.mjs';
import { buildSystemHealth } from './systemHealth.mjs';
import { assessSchemaIntegrity } from './schemaHealth.mjs';
import { attachRequestContext, operationalLog } from './observability.mjs';
import { isPublicDeploymentRequest } from './security.mjs';

export function liveProbe(req,res){
  const context=attachRequestContext(req,res,'/api/live');
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;operationalLog(context,405,'method_not_allowed');return res.end(JSON.stringify({error:'method_not_allowed',request_id:context.requestId}));}
  res.statusCode=200;operationalLog(context,200,'liveness_ok');
  return res.end(JSON.stringify({service:'ZEVANORY',live:true,release_id:RELEASE.id,request_id:context.requestId}));
}

export async function healthProbe(req,res){
  const context=attachRequestContext(req,res,'/api/health');
  res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  if(req.method!=='GET'){res.statusCode=405;operationalLog(context,405,'method_not_allowed');return res.end(JSON.stringify({error:'method_not_allowed',request_id:context.requestId}));}
  let databaseReachable=false,schema=assessSchemaIntegrity(),schemaCheckError=false;
  if(process.env.DATABASE_URL){
    const sql=neon(process.env.DATABASE_URL);
    try{const ping=await sql.query('select 1::int as ok');databaseReachable=ping[0]?.ok===1;}catch{databaseReachable=false;}
    if(databaseReachable){try{
      const [tables,migrations]=await Promise.all([sql.query("select table_name from information_schema.tables where table_schema='public'"),sql.query('select migration_id from schema_migrations order by migration_id')]);
      schema=assessSchemaIntegrity({tableNames:tables.map(row=>row.table_name),migrationIds:migrations.map(row=>row.migration_id)});
    }catch{schemaCheckError=true;schema=assessSchemaIntegrity();}}
  }  const health=buildSystemHealth({databaseReachable,schemaReady:schema.ready});
  res.statusCode=health.ready?200:503;
  operationalLog(context,res.statusCode,health.ready?'readiness_ok':'readiness_degraded',{database_reachable:databaseReachable,schema_ready:schema.ready,schema_check_error:schemaCheckError});
  const full={...health,schema,schema_check_error:schemaCheckError,request_id:context.requestId};
  if(!isPublicDeploymentRequest(req)) return res.end(JSON.stringify(full));
  const publicHealth={service:health.service,live:health.live,ready:health.ready,checks:{database_reachable:health.checks.database_reachable,schema_ready:health.checks.schema_ready,public_base_url_valid:health.checks.public_base_url_valid,commercial_safety_locked:health.checks.commercial_safety_locked},schema:{ready:schema.ready,required_tables:schema.required_tables,required_migrations:schema.required_migrations,missing_tables_count:Array.isArray(schema.missing_tables)?schema.missing_tables.length:null,missing_migrations_count:Array.isArray(schema.missing_migrations)?schema.missing_migrations.length:null},commercial_controls:{enabled:Object.values(health.commercial_switches||{}).filter(Boolean).length,total:Object.keys(health.commercial_switches||{}).length},request_id:context.requestId};
  return res.end(JSON.stringify(publicHealth));
}
