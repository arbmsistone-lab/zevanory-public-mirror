import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dbEconomySkip, closedProven } from "../worker/db-economy.mjs";

const at = (iso) => ({ scheduledTime: Date.parse(iso) });
const kvOk = (raw) => ({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => raw } });
const FECHADO = '{"enabled":false,"at":"2026-10-15T01:01:03Z","by":"owner-close"}';
const T = at("2026-10-20T03:35:00Z");

test("prova positiva de fechamento: só 4 tiques por dia consultam o banco (00/06/12/18 UTC, minuto < 30)", async () => {
  let runs = 0;
  for (let h = 0; h < 24; h++) for (const m of [5, 15, 35, 45]) {
    const iso = `2026-10-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
    if ((await dbEconomySkip(kvOk(FECHADO), at(iso))) === null) runs++;
  }
  assert.equal(runs, 8, "4 horas x 2 crons (:05 e :15)");
});

test("vendas abertas, pedido ou autorização: nunca pula", async () => {
  for (const raw of ['{"enabled":true}', '{"enabled":false,"requested":true}', '{"enabled":false,"authorized":true}', '{"enabled":"false"}', '{"enabled":0}']) {
    assert.equal(await dbEconomySkip(kvOk(raw), T), null, raw);
  }
});

test("contraprovas do Sol (Ordem 009): sem prova positiva, executa", async () => {
  // 1. registro sem enabled explícito não confirma fechamento
  assert.equal(await dbEconomySkip(kvOk('{"requested":false}'), T), null);
  // 2. chave ausente (null) não é prova de fechamento; e não há segunda leitura que possa falhar e "fechar"
  assert.equal(await dbEconomySkip(kvOk(null), T), null);
  let leituras = 0;
  const uma = { ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { leituras++; if (leituras > 1) throw new Error("segunda leitura"); return FECHADO; } } };
  assert.equal(await dbEconomySkip(uma, T), "vendas_fechadas_economia_banco"); assert.equal(leituras, 1, "exatamente uma leitura");
});

test("falha segura: exceção, KV ausente, valor ilegível ou não-objeto executam como antes", async () => {
  assert.equal(await dbEconomySkip({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { throw new Error("x"); } } }, T), null);
  assert.equal(await dbEconomySkip({}, T), null);
  for (const raw of ["{nao-json", "[]", "null", '"fechado"', "false"]) assert.equal(await dbEconomySkip(kvOk(raw), T), null, raw);
  assert.equal(closedProven(FECHADO), true);
});

test("o Worker aplica a economia nas duas tarefas de cron que consultam o banco e mantém o batimento", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ dbEconomySkip \} from "\.\/db-economy\.mjs";/);
  const i535 = src.indexOf('controller?.cron === "5,35 * * * *"'), i1545 = src.indexOf('controller?.cron === "15,45 * * * *"');
  const sync = src.indexOf("syncProductionActivity(normalized", i535), skip1 = src.indexOf("await dbEconomySkip(normalized, controller)", i535);
  assert.ok(skip1 > i535 && skip1 < sync, "economia antes da sincronização com o banco");
  const proof = src.indexOf("refreshFinancialProofSnapshot(normalized", i1545), skip2 = src.indexOf("await dbEconomySkip(normalized, controller)", i1545);
  assert.ok(skip2 > i1545 && skip2 < proof, "economia antes da prova financeira");
  assert.match(src.slice(skip2, proof), /putBeat\(normalized\.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:isolated"/);
});
