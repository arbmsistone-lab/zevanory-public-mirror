const EVALUATOR_VERSION="ZEA-10/2026.09-evaluator-v1";

export const ZEA10_MAP=[
  {id:"ZEA10-01",name:"Maturidade e prontidão operacional",requires:["P05","P08","P10","P12","P16"]},
  {id:"ZEA10-02",name:"Arquitetura e engenharia de sistemas",requires:["P01","P11","P15"]},
  {id:"ZEA10-03",name:"Performance e eficiência computacional",requires:["P03","P08","P12"]},
  {id:"ZEA10-04",name:"Qualidade de software",requires:["P02","P04","P05","P06"]},
  {id:"ZEA10-05",name:"Safety e integridade funcional",requires:["P05","P06","P09","P10"]},
  {id:"ZEA10-06",name:"Cibersegurança",requires:["P07","P15"]},
  {id:"ZEA10-07",name:"Qualidade global do produto",requires:["P02","P03","P04","P05","P06"]},
  {id:"ZEA10-08",name:"Automação e integrações",requires:["P08","P14"]},
  {id:"ZEA10-09",name:"Segurança da informação e governança",requires:["P07","P13","P15"]},
  {id:"ZEA10-10",name:"Validação, testes extremos, resiliência e recuperação",requires:["P06","P09","P10","P12"]}
];

function normalizeState(value){
  const v=String(value||"").toUpperCase();
  if(v==="PROVADO"||v==="PROVEN") return "PROVEN";
  if(v==="PARTIAL") return "PARTIAL";
  if(v==="BLOCKED") return "BLOCKED";
  return "UNKNOWN";
}

export function evaluateZea10FromZees16(zees16){
  const byId=new Map((zees16?.pillars||[]).map(p=>[p.id,p]));
  const releaseSha=zees16?.release_sha||null;
  const pillars=ZEA10_MAP.map(def=>{
    const evidence=def.requires.map(id=>{
      const source=byId.get(id);
      const state=normalizeState(source?.state);
      return {
        source_layer:"ZEES-16",
        source_pillar:id,
        state,
        decision_hash:zees16?.decision_hash||null,
        release_sha:source?.release_sha||releaseSha
      };
    });
    const states=evidence.map(x=>x.state);
    let state="UNKNOWN";
    if(states.some(x=>x==="BLOCKED")) state="BLOCKED";
    else if(states.length>0&&states.every(x=>x==="PROVEN")) state="PROVEN";
    else if(states.some(x=>x==="PROVEN"||x==="PARTIAL")) state="PARTIAL";
    return {
      id:def.id,
      name:def.name,
      state,
      requires:def.requires,
      evidence,
      blockers:evidence.filter(x=>x.state!=="PROVEN").map(x=>x.source_pillar)
    };
  });

  return {
    framework:"ZEA-10",
    evaluator:EVALUATOR_VERSION,
    role:"evaluation",
    source_layer:"ZEES-16",
    authority:false,
    release_sha:releaseSha,
    source_decision_hash:zees16?.decision_hash||null,
    counts:{
      proven:pillars.filter(x=>x.state==="PROVEN").length,
      partial:pillars.filter(x=>x.state==="PARTIAL").length,
      blocked:pillars.filter(x=>x.state==="BLOCKED").length,
      unknown:pillars.filter(x=>x.state==="UNKNOWN").length
    },
    pillars
  };
}
