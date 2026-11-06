#!/usr/bin/env node
// R9-D1 (Sol 237), passo (6) de docs/ops/operator-token-transition.md: prova SEM EFEITO COLATERAL de que a credencial
// NOVA (env ZEVANORY_OPERATOR_TOKEN, sem queda para o nome antigo) é aceita pelo verificador HMAC x-commercial-signature
// do Worker de controle (controle.zevanory.api.br, zevanory-product-control-edge cf-worker/commercial-hmac.ts), o mesmo
// verificador dos 4 jobs T2.
//
// Rota: POST /api/commercial/auth/probe (edge #211). Ela usa o MESMO conjunto de candidatos das rotas T2 sobre a canônica
// separada "zevanory-commercial-auth-probe-v1" (uma assinatura desta sonda nunca vale numa rota T2, nem o contrário) e
// não gera imagem, não grava KV/Supabase, não publica, não cobra e não chama Meta/IA. Responde só categorias.
//
// --require-primary: exige category=primary (o Worker de controle aceitou o valor NOVO, e não o antigo nem o tick).
// Saídas: só HTTP, categoria e estado da janela. Nunca valor, tamanho, hash ou assinatura.
// Origem fixa; CONTROL_EDGE_PROBE_ORIGIN só é aceita como http://127.0.0.1:<porta> (testes locais).
import { createHmac, randomUUID } from "node:crypto";

export const PROBE_PURPOSE = "zevanory-commercial-auth-probe-v1";
export const PROBE_PATH = "/api/commercial/auth/probe";
const DEFAULT_ORIGIN = "https://controle.zevanory.api.br";
const CATEGORIES = new Set(["primary", "legacy", "tick"]);
const MIGRATION = new Set(["open", "absent", "invalid", "expired", "beyond_code_ceiling"]);

export function probeHeaders(secret, { now = Date.now(), nonce = randomUUID() } = {}) {
  const timestamp = String(now);
  const signature = createHmac("sha256", secret).update([PROBE_PURPOSE, timestamp, nonce].join("\n")).digest("hex");
  return { "x-commercial-timestamp": timestamp, "x-commercial-nonce": nonce, "x-commercial-signature": signature, "cache-control": "no-store" };
}

function origin(env) {
  const o = String(env.CONTROL_EDGE_PROBE_ORIGIN || "");
  if (!o) return DEFAULT_ORIGIN;
  if (/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(o)) return o;
  throw new Error("CONTROL_EDGE_PROBE_ORIGIN_REFUSED");
}

export async function runProbe({ env = process.env, requirePrimary = false, fetchImpl = fetch } = {}) {
  const out = { CONTROL_EDGE_HMAC_PROBE: "FAIL", HTTP: "none", CATEGORY: "none", MIGRATION: "unknown", REASON: "" };
  const secret = String(env.ZEVANORY_OPERATOR_TOKEN || "");
  if (secret.length < 32) return { ...out, REASON: "RUNNER_TOKEN_ABSENT_OR_SHORT" };
  let res;
  try {
    res = await fetchImpl(origin(env) + PROBE_PATH, { method: "POST", headers: probeHeaders(secret), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return { ...out, REASON: String(e?.message || "").includes("REFUSED") ? "ORIGIN_REFUSED" : "NETWORK" };
  }
  out.HTTP = String(res.status);
  let body = {};
  try { body = await res.json(); } catch {}
  out.CATEGORY = CATEGORIES.has(body?.category) ? body.category : "none";
  out.MIGRATION = MIGRATION.has(body?.migration) ? body.migration : "unknown";
  if (res.status === 404 || res.status === 405) return { ...out, REASON: "PROBE_ROUTE_ABSENT (deploy edge #211 first)" };
  if (res.status === 401) return { ...out, REASON: "CREDENTIAL_NOT_ACCEPTED" };
  if (res.status !== 200 || body?.ok !== true || body?.sideEffects !== "none" || out.CATEGORY === "none") return { ...out, REASON: "UNEXPECTED_RESPONSE" };
  if (requirePrimary && out.CATEGORY !== "primary") return { ...out, REASON: "RUNNER_TOKEN_NOT_PRIMARY" };
  return { ...out, CONTROL_EDGE_HMAC_PROBE: "PASS" };
}

const isMain = String(process.argv[1] || "").endsWith("control_edge_hmac_probe.mjs");
if (isMain) {
  const r = await runProbe({ requirePrimary: process.argv.includes("--require-primary") });
  for (const [k, v] of Object.entries(r)) if (v !== "") console.log(`${k}=${v}`);
  process.exit(r.CONTROL_EDGE_HMAC_PROBE === "PASS" ? 0 : 1);
}
