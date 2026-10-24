import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Entrada `scheduled` REAL do Worker (via carregador local tests/t4_sim, sem rede): o cron horário despacha o dreno
// do outbox de suporte@ numa invocação própria (SELF), com token aceito, ANTES de qualquer outra chamada de rede.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
function probe(cron, mode = "") {
  const p = spawnSync(process.execPath, ["--import", "./tests/t4_sim/register.mjs", "tests/helpers/support-drain-scheduled-probe.mjs", cron, mode], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const line = String(p.stdout || "").split("\n").find((l) => l.startsWith("PROBE_RESULT "));
  assert.ok(line, "sonda sem resultado: " + String(p.stderr || "").slice(-400));
  return JSON.parse(line.slice("PROBE_RESULT ".length));
}

test("cron horário chama o dreno do outbox primeiro, via SELF, com token HMAC aceito", () => {
  const out = probe("0 * * * *");
  assert.ok(!out.timeout);
  const selfCalls = out.events.filter((e) => e.startsWith("self:"));
  assert.deepEqual(selfCalls, ["self:/api/internal/support/outbox/drain:200"]);
  assert.equal(out.events[0], "self:/api/internal/support/outbox/drain:200", "antes de qualquer outra rede: " + out.events.slice(0, 3).join(","));
  assert.equal(out.rejected, null, "fila em dia: execução verde");
});

test("fila do suporte@ vencida deixa a execução do cron horário VERMELHA (as demais tarefas rodam antes)", () => {
  const out = probe("0 * * * *", "overdue");
  assert.equal(out.rejected, "support_backlog_overdue");
  assert.ok(out.events.filter((e) => e === "net").length > 0, "as demais tarefas rodaram antes do erro");
});
