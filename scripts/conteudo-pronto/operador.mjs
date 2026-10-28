#!/usr/bin/env node
// Operação do Conteúdo Pronto (auditoria #953 M1/M2). Uso pelo proprietário ou operador, nunca pela CI:
//   ZEVANORY_OPERATOR_TOKEN=... node scripts/conteudo-pronto/operador.mjs status
//   ZEVANORY_OPERATOR_TOKEN=... node scripts/conteudo-pronto/operador.mjs requeue <12 últimos caracteres do assinante> \
//       --operator "nome" --reason "motivo com pelo menos 10 caracteres" --yes
// status: fila, tentativas, fila de falhas, boas-vindas pendentes, alertas gravados e log (sem e-mail nem nome).
// requeue: devolve UM item da fila de falhas para a fila automática; a operação fica registrada (operador e motivo).
// O token é lido do ambiente e nunca é impresso. ZEVANORY_ORIGIN muda o destino (padrão: produção).
const [cmd, sub, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : ""; };
const token = String(process.env.ZEVANORY_OPERATOR_TOKEN || "").trim();
const origin = String(process.env.ZEVANORY_ORIGIN || "https://zevanory.api.br").replace(/\/+$/, "");
function fail(msg) { console.error("operador: " + msg); process.exit(2); }
if (!["status", "requeue"].includes(cmd)) fail("comando: status | requeue <sub> --operator <nome> --reason <motivo> --yes");
if (!token) fail("defina ZEVANORY_OPERATOR_TOKEN no ambiente");
const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
let res;
if (cmd === "status") {
  res = await fetch(origin + "/api/admin/conteudo-pronto/status", { headers });
} else {
  const operator = flag("operator"), reason = flag("reason");
  if (!sub || !operator || reason.trim().length < 10) fail("requeue exige <sub>, --operator e --reason (10+ caracteres)");
  if (!rest.includes("--yes")) fail("requeue altera a fila de produção: confirme com --yes");
  res = await fetch(origin + "/api/admin/conteudo-pronto/requeue", { method: "POST", headers, body: JSON.stringify({ sub, operator, reason }) });
}
const body = await res.text();
console.log(res.status, body);
process.exit(res.ok ? 0 : 1);
