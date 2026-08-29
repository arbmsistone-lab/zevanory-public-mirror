export const COMPOSABLE_ARCHITECTURE = Object.freeze({
  profile: 'modular-monolith-ports-adapters-transactional-outbox',
  principles: Object.freeze(['api-first','headless','cloud-native','composable','fail-closed']),
  modules: Object.freeze({
    experience: Object.freeze({ dependsOn: Object.freeze(['revenue','platform']) }),
    revenue: Object.freeze({ dependsOn: Object.freeze(['commerce','intelligence','integrations','platform']) }),
    commerce: Object.freeze({ dependsOn: Object.freeze(['platform']) }),
    intelligence: Object.freeze({ dependsOn: Object.freeze(['commerce','platform']) }),
    integrations: Object.freeze({ dependsOn: Object.freeze(['commerce','platform']) }),
    platform: Object.freeze({ dependsOn: Object.freeze([]) }),
  }),
  integrationPattern: 'transactional-outbox',
  migrationPattern: 'strangler',
  distributedMicroservicesRequired: false,
  paidInfrastructureRequired: false,
});

export function validateArchitectureContract(profile = COMPOSABLE_ARCHITECTURE) {
  const names = Object.keys(profile.modules || {});
  const known = new Set(names);
  for (const name of names) {
    const deps = profile.modules[name]?.dependsOn || [];
    if (deps.includes(name)) return Object.freeze({ valid:false, reason:`self_dependency:${name}` });
    for (const dep of deps) if (!known.has(dep)) return Object.freeze({ valid:false, reason:`unknown_dependency:${name}:${dep}` });
  }
  const visiting = new Set(); const visited = new Set();
  const dfs = (name) => {
    if (visiting.has(name)) return false;
    if (visited.has(name)) return true;
    visiting.add(name);
    for (const dep of profile.modules[name].dependsOn) if (!dfs(dep)) return false;
    visiting.delete(name); visited.add(name); return true;
  };
  return Object.freeze({ valid:names.every(dfs), reason:names.every((n)=>visited.has(n))?'ok':'cycle_detected' });
}
