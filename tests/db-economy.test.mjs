import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dbEconomySkip } from "../worker/db-economy.mjs";
import { applySalesSwitch } from "../worker/sales-control.mjs";

const at = (iso) => ({ scheduledTime: Date.parse(iso) });
const kvOk = (raw) => ({ ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => raw } });
const closed = { enabled: false, requested: false, revision: "r" };
const deps = (state) => ({ readSwitch: async () => state, isOpen: applySalesSwitch, resetCache: () => {} });

test("vendas fechadas: só 4 tiques por dia consultam o banco (00/06/12/18 UTC, minuto < 30)", async () => {
  let runs = 0;
  for (let h = 0; h < 24; h++) for (const m of [5, 15, 35, 45]) {
    const iso = `2026-10-20T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
    if ((await dbEconomySkip(kvOk(null), at(iso), deps(closed))) === null) runs++;
  }
  assert.equal(runs, 8, "4 horas x 2 crons (:05 e :15)");
});

test("vendas abertas, pedido de abertura ou autorização: nunca pula", async () => {
  for (const s of [{ enabled: true }, { enabled: false, requested: true }, { enabled: false, authorized: true }]) {
    assert.equal(await dbEconomySkip(kvOk(null), at("2026-10-20T03:35:00Z"), deps(s)), null, JSON.stringify(s));
  }
});

test("falha segura: exceção na leitura, estado ausente ou dependências ausentes executam como antes", async () => {
  assert.equal(await dbEconomySkip({}, at("2026-10-20T03:35:00Z"), { readSwitch: async () => { throw new Error("x"); }, isOpen: applySalesSwitch }), null);
  assert.equal(await dbEconomySkip({}, at("2026-10-20T03:35:00Z"), deps(null)), null);
  assert.equal(await dbEconomySkip({}, at("2026-10-20T03:35:00Z"), {}), null);
  assert.equal(await dbEconomySkip(kvOk(null), at("2026-10-20T03:35:00Z"), deps(closed)), "vendas_fechadas_economia_banco");
});

test("o Worker aplica a economia nas duas tarefas de cron que consultam o banco e mantém o batimento", () => {
  const src = readFileSync(new URL("../worker/cloudflare-worker.compat.mjs", import.meta.url), "utf8");
  const i535 = src.indexOf('controller?.cron === "5,35 * * * *"'), i1545 = src.indexOf('controller?.cron === "15,45 * * * *"');
  const sync = src.indexOf("syncProductionActivity(normalized", i535), skip1 = src.indexOf("await dbEconomySkip(normalized, controller)", i535);
  assert.ok(skip1 > i535 && skip1 < sync, "economia antes da sincronização com o banco");
  const proof = src.indexOf("refreshFinancialProofSnapshot(normalized", i1545), skip2 = src.indexOf("await dbEconomySkip(normalized, controller)", i1545);
  assert.ok(skip2 > i1545 && skip2 < proof, "economia antes da prova financeira");
  assert.match(src.slice(skip2, proof), /putBeat\(normalized\.ZEVANORY_PRIVATE_ARTIFACTS, "zpc:cron:v1:isolated"/);
});


test("D1 (Sol, Ordem 008): falha ao ler o KV nunca vira 'fechado' — executa", async () => {
  const quebrado = { ZEVANORY_PRIVATE_ARTIFACTS: { get: async () => { throw new Error("kv indisponível"); } } };
  // readSalesSwitch real converte erro em fechado; o dublê reproduz isso
  assert.equal(await dbEconomySkip(quebrado, at("2026-10-20T03:35:00Z"), deps(closed)), null);
  assert.equal(await dbEconomySkip({}, at("2026-10-20T03:35:00Z"), deps(closed)), null, "sem binding de KV");
  assert.equal(await dbEconomySkip(kvOk("{nao-json"), at("2026-10-20T03:35:00Z"), deps(closed)), null, "valor ilegível");
});

test("a leitura bruta decide: interruptor ligado ou pedido no KV impede o salto mesmo se readSalesSwitch disser fechado", async () => {
  for (const raw of ['{"enabled":true}', '{"enabled":false,"requested":true}', '{"enabled":"true"}', '{"authorized":true}']) {
    assert.equal(await dbEconomySkip(kvOk(raw), at("2026-10-20T03:35:00Z"), deps(closed)), null, raw);
  }
  assert.equal(await dbEconomySkip(kvOk(null), at("2026-10-20T03:35:00Z"), deps(closed)), "vendas_fechadas_economia_banco", "chave ausente = nunca aberto");
  assert.equal(await dbEconomySkip(kvOk('{"enabled":false,"at":"x"}'), at("2026-10-20T03:35:00Z"), deps(closed)), "vendas_fechadas_economia_banco");
});
