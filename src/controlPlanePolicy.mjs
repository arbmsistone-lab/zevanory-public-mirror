import { RELEASE, runtimeReleaseModes } from './release.mjs';
import { salesGate } from './salesGate.mjs';

const APPROVED = new Set(['approved','approved_39x10_technical_release']);
const approved = (key) => APPROVED.has(String(RELEASE.assurance?.[key] || '').toLowerCase());
const validSha = (value) => /^[0-9a-f]{40}$/i.test(String(value || '').trim());
const state = (checks) => {
  const values = checks.map(Boolean);
  if (values.every(Boolean)) return 'proven';
  if (values.some(Boolean)) return 'partial';
  return 'blocked';
};

export const ZEA10 = Object.freeze([
  {id:'ZEA10-01',name:'Maturidade e prontidão operacional',reference:'TRL 9',evidence:['quality_gate','enterprise_10x','final_20x']},
  {id:'ZEA10-02',name:'Arquitetura e engenharia de sistemas',reference:'ESEP / INCOSE',evidence:['architecture_20x','composable_10x5','enterprise_10x']},
  {id:'ZEA10-03',name:'Performance e eficiência computacional',reference:'Cybenetics / eficiência computacional',evidence:['observability_10x','resilience']},
  {id:'ZEA10-04',name:'Qualidade de software',reference:'IEEE / PSEM',evidence:['quality_gate','audit_30x','final_20x']},
  {id:'ZEA10-05',name:'Safety e integridade funcional',reference:'SIL 4',evidence:['rules_audit_20x','resilience','contract_smoke']},
  {id:'ZEA10-06',name:'Cibersegurança',reference:'EAL7',evidence:['security_10x','supplychain_scan']},
  {id:'ZEA10-07',name:'Qualidade global do produto',reference:'ISO/IEC 25010',evidence:['worldclass_dashboard','visual_certification','quality_gate']},
  {id:'ZEA10-08',name:'Automação e integrações',reference:'ISA / automação',evidence:['autonomous_engine_20x','command_center_20x','contract_smoke']},
  {id:'ZEA10-09',name:'Segurança da informação e governança',reference:'ISO 27001 / CIS',evidence:['security_10x','rules_audit_20x','supplychain_scan']},
  {id:'ZEA10-10',name:'Validação, testes extremos, resiliência e recuperação',reference:'Digital twin / fault simulation',evidence:['resilience','dr_10x','audit_30x']},
]);

export function buildZea10PolicySnapshot(env = process.env) {
  const releaseSha = String(env.VERCEL_GIT_COMMIT_SHA || env.ZEVANORY_RELEASE_SHA || '').trim().toLowerCase();
  const releaseEvidence = validSha(releaseSha);
  const pillars = ZEA10.map((pillar) => {
    const checks = pillar.evidence.map((key) => ({key,ok:approved(key),value:RELEASE.assurance?.[key] || null}));
    const evidenceState = state(checks.map((x) => x.ok));
    const finalState = releaseEvidence ? evidenceState : (evidenceState === 'blocked' ? 'blocked' : 'partial');
    return Object.freeze({...pillar,state:finalState,evidence:checks,release_sha_bound:releaseEvidence});
  });
  const counts = pillars.reduce((acc,p)=>{acc[p.state]=(acc[p.state]||0)+1;return acc;},{proven:0,partial:0,blocked:0});
  return Object.freeze({
    framework:'ZEA-10',
    claim_scope:'internal_engineering_alignment_not_external_certification',
    release_sha:releaseEvidence?releaseSha:null,
    counts:Object.freeze(counts),
    pillars:Object.freeze(pillars),
  });
}

export function buildControlPlaneSnapshot(env = process.env) {
  const modes=runtimeReleaseModes(env);
  const gate=salesGate(env);
  const policy=buildZea10PolicySnapshot(env);
  const deployment=Object.freeze({
    environment:String(env.VERCEL_ENV || env.ZEVANORY_DEPLOYMENT_ENV || 'local'),
    branch:String(env.VERCEL_GIT_COMMIT_REF || env.ZEVANORY_RELEASE_REF || '') || null,
    commit_sha:policy.release_sha,
    region:String(env.VERCEL_REGION || env.ZEVANORY_DEPLOYMENT_REGION || '') || null,
  });
  const blocked = !gate.enabled || modes.salesMode !== 'enabled';
  return Object.freeze({
    service:'ZEVANORY',
    surface:'control-plane-vnext',
    global_state:blocked?'operational_commercial_blocked':'operational_commercial_enabled',
    root_blocker:blocked?(gate.blockers?.[0] || 'commercial_evidence_required'):null,
    release:Object.freeze({id:RELEASE.id,structural_completion:RELEASE.structuralCompletion,deployment}),
    policy,
    domains:Object.freeze({
      products:{state:blocked?'partial':'ready'},
      operations:{state:'ready'},
      revenue:{state:blocked?'blocked':'ready'},
      ai_automation:{state:modes.salesMode==='enabled'?'ready':'partial'},
      infrastructure:{state:deployment.commit_sha?'ready':'partial'},
      risk_compliance:{state:policy.counts.blocked>0?'blocked':policy.counts.partial>0?'partial':'ready'},
    }),
    proof_chain:Object.freeze({
      sha:deployment.commit_sha,
      release:RELEASE.id,
      assurance:'release-assurance',
      deployment_environment:deployment.environment,
      branch:deployment.branch,
    }),
  });
}
