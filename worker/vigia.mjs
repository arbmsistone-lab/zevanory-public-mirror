// Vigia v2 (Epaminondas). Requisito permanente do proprietário (12/11/2026): IDENTIFICAR -> DIAGNOSTICAR ->
// CORRIGIR -> CONFIRMAR -> AVISAR. Critério de aceite (proprietário/GPT-6/Codex):
//  * dado ausente, vencido, ilegível ou incompleto = DESCONHECIDO, nunca saúde (NC-CX-1031-01);
//  * RESOLVIDO só com observação SAUDÁVEL da MESMA chave, POSTERIOR à abertura do incidente;
//  * identidade do incidente no PostgreSQL (uma ocorrência aberta por chave, índice único parcial) e avisos por
//    outbox idempotente: concorrência e falhas de gravação não duplicam nem perdem avisos (NC-CX-1031-02/03);
//  * texto montado só de códigos/campos permitidos; nada de corpo livre de erro, query de URL ou credencial (04).
// Este módulo observa (sem rede, sem escrita). A persistência/notificação fica em runVigia (owner-chat.mjs).
export const CRON_BEAT_KEY = "zpc:cron:v1:hourly";
export const POST_SALE_STATUS_KEY = "zpc:posvenda:hotmart:status:v1";
export const VIGIA_ACTIONS_KEY = "zpc:vigia:actions:v2";
export const WATCHED_WORKFLOWS = Object.freeze(["p18-commercial-check.yml", "command-center-snapshot.yml", "p18-external-monitor.yml", "youtube-autonomous-short.yml", "indexnow-submit.yml", "central-production-integrity-audit.yml"]);
const HOUR = 3600000;
// Tolerância de relógio. Data além de agora + SKEW_MS é inválida: nunca vira evidência (NC-CX-1031-01, rodada 3).
export const SKEW_MS = 5 * 60000;
const validAt = (t, now) => Number.isFinite(t) && t <= now + SKEW_MS;
const REPO_RUNS = "https://github.com/arbmsistone-lab/zevanory-public-mirror/actions/runs/";
const obj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();

// Classificação de detalhe de erro: só categorias fixas, nunca o texto original.
export function errorCategory(detail) {
  const d = String(detail ?? "").toLowerCase();
  if (!d) return "sem detalhe";
  if (/timeout|timed out|tempo esgotado/.test(d)) return "tempo esgotado";
  const http = /\b([45]\d\d)\b/.exec(d);
  if (http) return "HTTP " + http[1];
  if (/postgres|neon|database|\bdb\b|sql/.test(d)) return "banco de dados";
  if (/\bkv\b|storage/.test(d)) return "armazenamento";
  if (/quota|limit|cota|429/.test(d)) return "cota";
  return "erro não classificado";
}
// Nomes de tarefa: só os registrados pelo ciclo horário (worker/cloudflare-worker.compat.mjs, mark(...)) aparecem
// no texto. Qualquer outro nome NÃO é copiado (pode ter formato de segredo, NC-CX-1031-04): vira "tarefa não
// identificada" e a chave usa um resumo FNV-1a do nome, para duas tarefas desconhecidas não se confundirem.
export const KNOWN_TASKS = Object.freeze(["delivery_watchdog", "nurture", "owner_chat_retention"]);
const fnv = (t) => { let h = 0x811c9dc5; for (const c of String(t)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
const taskKey = (t) => (KNOWN_TASKS.includes(t) ? t : "desconhecida_" + fnv(t));
const taskLabel = (t) => (KNOWN_TASKS.includes(t) ? `"${t}"` : "não identificada");
const POST_SALE_CODES = Object.freeze({ provider_restricted: "chave do Resend sem permissão de leitura", quota_ledger_unreadable: "livro de cota ilegível", post_sale_inconclusive: "resultado inconclusivo", provider_usage_invalid: "resposta de uso inválida", reconciliation_pending: "entrega aguardando confirmação" });

async function readJson(kv, key) {
  let raw;
  try { raw = await kv.get(key); } catch { return { state: "erro" }; }
  if (raw === null) return { state: "ausente" };
  try { return { state: "ok", value: JSON.parse(raw) }; } catch { return { state: "ilegivel" }; }
}

// Observação: { key, health: "falha"|"saudavel", at (ms da evidência), text, fix }. Escopo desconhecido não gera
// observação para as chaves dele (nem falha nem saúde) e vira, quando persistente, falha de observabilidade.
export function observeCron(read, now) {
  if (read.state === "ausente") return [];
  if (read.state !== "ok" || !obj(read.value) || !obj(read.value.tasks)) return [{ key: "vigia:sem-dados:ciclo", health: "falha", at: now, text: "O registro do ciclo horário está ilegível; não consigo confirmar a saúde das tarefas.", fix: "Nível 3: conferir o Worker." }];
  const at = Date.parse(read.value.finishedAt || "");
  if (!validAt(at, now)) return [{ key: "vigia:sem-dados:ciclo", health: "falha", at: now, text: "O registro do ciclo horário não tem data válida (ausente ou no futuro).", fix: "Nível 3: conferir o Worker e o relógio." }];
  const out = [{ key: "vigia:sem-dados:ciclo", health: "saudavel", at }];
  if (now - at > 2 * HOUR) { out.push({ key: "ciclo:parado", health: "falha", at: now, text: `O ciclo horário não roda desde ${iso(at).slice(0, 16).replace("T", " ")} UTC.`, fix: "Nível 3: conferir o deploy e os gatilhos do Worker." }); return out; }
  out.push({ key: "ciclo:parado", health: "saudavel", at });
  for (const [task, status] of Object.entries(read.value.tasks)) {
    const k = "ciclo:falha:" + taskKey(task);
    if (status === "ok") out.push({ key: k, health: "saudavel", at });
    else if (typeof status === "string" && status.startsWith("fail")) out.push({ key: k, health: "falha", at, text: `A tarefa automática ${taskLabel(task)} falhou no último ciclo (${errorCategory(status.slice(5))}).`, fix: "Nível 1: o ciclo tenta de novo na próxima hora; se repetir, nível 3." });
  }
  return out;
}

// Mesmo contrato do gravador (worker/hotmart-post-sale.mjs, #1025): exatamente {em,resultado,codigo,pendentes},
// em ISO canônico e não futuro, e coerência entre resultado, código e pendentes. Estado contraditório (ex.: "ok"
// com pendentes, "ok" com código de falha, "inconclusivo" com "completed") é ILEGÍVEL, nunca saúde (NC-CX-1031-01).
const POST_SALE_FAIL_CODES = Object.freeze(["post_sale_inconclusive", "provider_restricted", "quota_ledger_unreadable", "provider_usage_invalid", "reconciliation_pending"]);
export function validPostSaleStatus(v, now) {
  if (!obj(v) || Object.keys(v).sort().join(",") !== "codigo,em,pendentes,resultado") return false;
  if (typeof v.em !== "string" || !Number.isFinite(Date.parse(v.em)) || new Date(Date.parse(v.em)).toISOString() !== v.em || Date.parse(v.em) > now + 5 * 60000) return false;
  if (!["ok", "inconclusivo", "reconciliacao_pendente"].includes(v.resultado) || typeof v.codigo !== "string" || !/^[a-z_]{1,64}$/.test(v.codigo)) return false;
  if (!Number.isSafeInteger(v.pendentes) || v.pendentes < 0) return false;
  if (v.resultado === "reconciliacao_pendente") return v.pendentes > 0;
  if (v.pendentes !== 0) return false;
  if (v.resultado === "ok") return !POST_SALE_FAIL_CODES.includes(v.codigo);
  return v.codigo !== "completed";
}
export function observePostSale(read, now) {
  if (read.state === "ausente") return [];
  const v = read.value;
  if (!(read.state === "ok" && validPostSaleStatus(v, now))) return [{ key: "vigia:sem-dados:pos-venda", health: "falha", at: now, text: "O estado do pós-venda está ilegível; não consigo confirmar se os e-mails saíram.", fix: "Nível 1: a próxima execução regrava o estado." }];
  const at = Date.parse(v.em);
  if (now - at > 3 * HOUR) return []; // vencido = desconhecido
  const out = [{ key: "vigia:sem-dados:pos-venda", health: "saudavel", at }];
  const code = POST_SALE_CODES[v.codigo] || "código não reconhecido";
  out.push(v.resultado === "inconclusivo" ? { key: "pos-venda:inconclusivo", health: "falha", at, text: `O pós-venda não conseguiu concluir (${code}). Nenhum e-mail foi reenviado às cegas.`, fix: "Nível 1: nova tentativa no próximo ciclo; se persistir, nível 2." } : { key: "pos-venda:inconclusivo", health: "saudavel", at });
  out.push(v.resultado === "reconciliacao_pendente" ? { key: "pos-venda:pendente", health: "falha", at, text: `${v.pendentes} e-mail(s) do pós-venda com entrega não confirmada; estou conferindo, sem reenviar.`, fix: "Nível 1: reconciliação automática a cada hora." } : { key: "pos-venda:pendente", health: "saudavel", at });
  return out;
}

export function observeActions(read, now) {
  const lost = (text) => [{ key: "vigia:sem-dados:github", health: "falha", at: now, text, fix: "Nível 3: conferir o workflow vigia-actions." }];
  if (read.state === "ausente") return [];
  const v = read.value;
  if (read.state !== "ok" || !obj(v) || v.schema !== 2 || !obj(v.workflows) || !validAt(Date.parse(v.at), now)) return lost("O resumo dos workflows do GitHub está ilegível ou com data inválida.");
  const at = Date.parse(v.at);
  if (now - at > 3 * HOUR) return lost("O vigia dos workflows do GitHub está sem dados há mais de 3 h.");
  const out = [{ key: "vigia:sem-dados:github", health: "saudavel", at }];
  for (const wf of WATCHED_WORKFLOWS) {
    const w = v.workflows[wf];
    if (!obj(w) || !["falha", "saudavel"].includes(w.state)) continue; // desconhecido: sem observação
    const runAt = Date.parse(w.at);
    if (!validAt(runAt, now) || runAt > at) continue; // data inválida, futura ou posterior ao próprio resumo = desconhecido
    const runId = Number.isSafeInteger(w.run_id) && w.run_id > 0 ? w.run_id : null;
    if (w.state === "saudavel") { out.push({ key: "github:" + wf, health: "saudavel", at: runAt }); continue; }
    const rerun = w.rerun === "feita" ? " Já mandei repetir uma vez." : w.rerun === "incerta" ? " Pedi para repetir e a resposta não chegou; não vou pedir de novo." : "";
    out.push({ key: "github:" + wf, health: "falha", at: runAt, text: `O workflow "${wf}" falhou na gh-pages.${rerun}${runId ? "\n" + REPO_RUNS + runId : ""}`, fix: w.rerun === "feita" ? "Nível 1: repetição automática em andamento." : "Nível 3: diagnóstico pelo log do run." });
  }
  return out;
}

export async function collectObservations(env, now = new Date()) {
  const kv = env.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv?.get) return [{ key: "vigia:sem-dados:kv", health: "falha", at: now.getTime(), text: "O armazenamento principal está indisponível.", fix: "Nível 3." }];
  const t = now.getTime();
  const [cron, post, actions] = await Promise.all([readJson(kv, CRON_BEAT_KEY), readJson(kv, POST_SALE_STATUS_KEY), readJson(kv, VIGIA_ACTIONS_KEY)]);
  return [...observeCron(cron, t), ...observePostSale(post, t), ...observeActions(actions, t)];
}
