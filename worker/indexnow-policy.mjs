// The repository planner is the only journaled IndexNow submitter in this release.
// Dynamic blog pages remain publishable but must not bypass continuity/quota controls.
export function withoutDirectIndexNow(fetchImpl){
 return (input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(url.hostname==='api.indexnow.org')return Promise.resolve(Response.json({accepted:false,code:'indexnow_journal_required'},{status:409}));
  return fetchImpl(input,options);
 };
}
