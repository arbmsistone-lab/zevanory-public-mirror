// R9 (roteiro v4.7; auditoria Sol 164 §4): o piloto de certificação NÃO existe no Worker de produção.
//
// O runtime canônico (cloudflare-worker.recovered.mjs, sandbox-proof-v2.mjs, compat) é o MESMO bundle que o Worker de
// certificação (certification-worker.mjs) importa: lá o piloto sandbox é legítimo e continua. Na produção, qualquer
// CERTIFICATION_PILOT_* (var do painel, var do deploy, chave dentro de ZEVANORY_RUNTIME_CONFIG ou resto em process.env)
// ligava caminhos de pagamento sandbox/sintético: resolveCheckoutProviderRequest (certificationSandbox),
// certificationPilotPolicy/convites, pilotSandbox do checkout, sandbox-proof-v2 (sandboxFailClosed), autorização de
// estorno Pix do Asaas, rota Node /api/internal/certification/e2e/status e o checkout piloto do compat.
//
// productionEnvView() é aplicado na ENTRADA do Worker de produção (fetch, scheduled, queue, email do compat), antes de
// qualquer leitura: fora do perímetro de certificação, todo nome CERTIFICATION_PILOT_* fica invisível (get -> undefined,
// has -> false, fora de ownKeys), inclusive dentro de ZEVANORY_RUNTIME_CONFIG, e os restos em process.env são apagados.
// Resultado fail-closed: com CERTIFICATION_PILOT_ENABLED=true a produção se comporta exatamente como sem a var.
// O perímetro é o mesmo de worker/operator-credential.mjs (duas marcas + nenhum nome exclusivo da produção).
import { isCertificationPerimeter } from "./operator-credential.mjs";

export const PILOT_NAME = /^CERTIFICATION_PILOT_/;
export const HIDDEN_PILOT_NAMES = Symbol.for("zevanory.r9.hiddenPilotNames");

function filteredRuntimeConfig(raw, hidden) {
  let config = raw;
  let wasString = false;
  if (typeof raw === "string") {
    wasString = true;
    try { config = JSON.parse(raw); } catch { return raw; }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return raw;
  const keys = Object.keys(config).filter((k) => PILOT_NAME.test(k));
  if (!keys.length) return raw;
  const copy = {};
  for (const [k, v] of Object.entries(config)) {
    if (PILOT_NAME.test(k)) hidden.add("ZEVANORY_RUNTIME_CONFIG." + k);
    else copy[k] = v;
  }
  return wasString ? JSON.stringify(copy) : copy;
}

export function scrubPilotFromProcessEnv(target = globalThis.process?.env) {
  if (!target || typeof target !== "object") return 0;
  let removed = 0;
  for (const key of Object.keys(target)) {
    if (PILOT_NAME.test(key)) {
      try { delete target[key]; removed += 1; } catch {}
    }
  }
  return removed;
}

export function productionEnvView(env) {
  if (!env || typeof env !== "object") return env;
  if (isCertificationPerimeter(env)) return env;
  scrubPilotFromProcessEnv();
  const hidden = new Set();
  for (const key of Reflect.ownKeys(env)) if (typeof key === "string" && PILOT_NAME.test(key)) hidden.add(key);
  const runtime = filteredRuntimeConfig(Reflect.get(env, "ZEVANORY_RUNTIME_CONFIG"), hidden);
  const blocked = (prop) => typeof prop === "string" && PILOT_NAME.test(prop);
  // Alvo vazio e extensível: o env do Cloudflare pode ser congelado e um Proxy sobre ele não pode esconder propriedade.
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === HIDDEN_PILOT_NAMES) return Object.freeze([...hidden].sort());
      if (blocked(prop)) return undefined;
      if (prop === "ZEVANORY_RUNTIME_CONFIG") return runtime;
      return Reflect.get(env, prop);
    },
    has(_t, prop) { return blocked(prop) ? false : Reflect.has(env, prop); },
    ownKeys() { return Reflect.ownKeys(env).filter((k) => !blocked(k)); },
    getOwnPropertyDescriptor(_t, prop) {
      if (blocked(prop)) return undefined;
      const d = Reflect.getOwnPropertyDescriptor(env, prop);
      if (!d) return undefined;
      return prop === "ZEVANORY_RUNTIME_CONFIG"
        ? { value: runtime, enumerable: d.enumerable, configurable: true, writable: false }
        : { ...d, configurable: true };
    },
  });
}

// Nomes escondidos nesta invocação (só nomes; para o readback de auditoria).
export function hiddenPilotNames(env) {
  try { return env?.[HIDDEN_PILOT_NAMES] || []; } catch { return []; }
}
