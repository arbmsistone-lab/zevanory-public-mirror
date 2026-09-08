const clean=(v,max=2000)=>String(v??'').trim().slice(0,max);

export function buildVerifiedReadRoutes(env=process.env){
  const routes=[];
  const canonical=clean(env.DATABASE_URL,2000);
  const dataset=clean(env.DATABASE_CANONICAL_DATASET_ID,200);
  if(canonical)routes.push(Object.freeze({id:'canonical',url:canonical,independence_domain:'canonical-data-source',verified:true,read_only:false,canonical:true}));
  for(let slot=1;slot<=4;slot+=1){
    const prefix=`DATABASE_READ_${slot}`;
    const url=clean(env[`${prefix}_URL`],2000);
    if(!url)continue;
    const verified=String(env[`${prefix}_VERIFIED`]||'').toLowerCase()==='true';
    const readOnly=String(env[`${prefix}_READ_ONLY`]||'').toLowerCase()==='true';
    const routeDataset=clean(env[`${prefix}_DATASET_ID`],200);
    if(!verified||!readOnly||!dataset||routeDataset!==dataset)continue;
    routes.push(Object.freeze({id:clean(env[`${prefix}_ID`],120)||`read-${slot}`,url,independence_domain:clean(env[`${prefix}_DOMAIN`],200)||`read-domain-${slot}`,verified:true,read_only:true,canonical:false}));
  }
  return Object.freeze(routes);
}

export async function executeVerifiedRead({env=process.env,connect,read}={}){
  if(typeof connect!=='function'||typeof read!=='function')throw new Error('read_fabric_invalid');
  const attempts=[];
  for(const route of buildVerifiedReadRoutes(env)){
    try{
      const sql=connect(route.url);
      const result=await read(sql,route);
      attempts.push(Object.freeze({route:route.id,status:'pass'}));
      return Object.freeze({ok:true,route:route.id,canonical:route.canonical,result,attempts:Object.freeze(attempts)});
    }catch(error){attempts.push(Object.freeze({route:route.id,status:'failed',reason:String(error?.message||'read_failed').slice(0,200)}));}
  }
  return Object.freeze({ok:false,reason:'no_verified_read_route_available',attempts:Object.freeze(attempts)});
}
