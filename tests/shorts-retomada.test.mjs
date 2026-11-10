// Retomada controlada dos Shorts (Plano Mestre v1.2, F1): rampa 1 → 2 → 3 por dia, texto sem WhatsApp nem lista de
// espera, CTA só /hotmart/<slug> ou calculadora gratuita com UTM, preflight do canal e congelamento, e o dispatcher sem
// martelar 422 com o workflow desativado. Os mutantes destas regras estão em tests/shorts-retomada-mutantes.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  textoProibido, violacoesShort, ctaPermitido, nivelRampa, decisaoSlot, avaliarPreflight, avaliarPosUpload,
  congelamentoAtivo, gravarUmaVez, diasDaJanela, somarDias, eQcFalha, CANAL_ESPERADO, CHAVE_CONGELADO
} from "../scripts/channels/shorts-retomada.mjs";
import { planSlot, SLOTS, RAMPA_CONFIG, historicoRampa, preflightCanal, congelarCanal, publicadosNoDia } from "../scripts/channels/youtube-daily-short.mjs";
import { captionFor } from "../scripts/channels/short-crosspost.mjs";
import { decide, workflowGate, shortSlotsAllowed } from "../scripts/ops/engine-dispatcher.mjs";

const CFG = JSON.parse(readFileSync(new URL("../data/shorts-rampa.json", import.meta.url), "utf8"));
const memKv = () => { const m = new Map(); let puts = 0; return { m, get puts() { return puts; }, get: async (k) => m.get(k) ?? null, put: async (k, v) => { puts++; m.set(k, v); } }; };
const PROIBIDO = /whats\s*-?\s*app|uótsap|\bzap\b|wa\.me|lista\s+de\s+espera/i;
const MODES = [{ salesOpen: false, hotmartOpen: false }, { salesOpen: false, hotmartOpen: true }];
const days = (n, start = "2026-11-10") => Array.from({ length: n }, (_, i) => somarDias(start, i));

test("configuração versionada: começa com 1 Short por dia (dica), sobe para 2 e 3 após 7 dias limpos; sem voz local nem Telegram", () => {
  assert.equal(CFG.schema, "shorts-rampa/v1");
  assert.deepEqual(RAMPA_CONFIG, CFG);
  assert.deepEqual(CFG.niveis.map((n) => n.por_dia), [1, 2, 3]);
  assert.deepEqual(CFG.niveis[0].slots, ["dica"]);
  assert.equal(CFG.niveis[0].dias_limpos_para_subir, 7); assert.equal(CFG.niveis[1].dias_limpos_para_subir, 7);
  for (const n of CFG.niveis) { assert.equal(n.slots.length, n.por_dia); for (const s of n.slots) assert.ok(SLOTS.includes(s)); }
  assert.equal(CFG.voz.permitir_voz_local, false); assert.equal(CFG.crosspost.telegram, false);
  assert.equal(CFG.canal.aviso_manual, false); assert.equal(CFG.canal.congelamento_liberado_em, null);
  assert.equal(CFG.contar_a_partir_de, "2026-11-10");
});

test("reprova qualquer menção a WhatsApp (canal banido) ou lista de espera em roteiro, tela, título, descrição e tags", () => {
  for (const t of ["Responder no WhatsApp", "mande no whats app", "Whats-App", "chama no zap", "https://wa.me/5511", "uótsap", "entre na lista de espera", "join the waitlist"]) assert.ok(textoProibido(t).length > 0, t);
  assert.deepEqual(textoProibido("Use a calculadora gratuita da ZEVANORY, sem cadastro."), []);
  const base = planSlot("2026-11-10", "dica");
  assert.deepEqual(violacoesShort(base), []);
  for (const campo of ["speech", "description", "title"]) {
    const p = { ...base, [campo]: base[campo] + " Responder no WhatsApp." };
    assert.ok(violacoesShort(p).includes("whatsapp"), campo);
  }
  assert.ok(violacoesShort({ ...base, said: [...base.said, ["Chame no WhatsApp."]] }).includes("whatsapp"));
  assert.ok(violacoesShort({ ...base, screen: { ...base.screen, cta: "Responder no WhatsApp" } }).includes("whatsapp"));
  assert.ok(violacoesShort({ ...base, tags: [...base.tags, "whatsapp"] }).includes("whatsapp"));
  assert.ok(violacoesShort({ ...base, description: base.description + "\nEntre na lista de espera." }).includes("lista_de_espera"));
});

test("nenhum Short planejado (3 slots × 80 dias × modo fechado e Hotmart) cita WhatsApp ou lista de espera, nem nas legendas do crosspost", () => {
  for (const day of days(80, "2026-10-12")) for (const slot of SLOTS) for (const mode of MODES) {
    const p = planSlot(day, slot, mode);
    assert.equal(p.gate.action, "publish", `${day} ${slot} ${JSON.stringify(mode)} ${p.gate.reason}`);
    const text = [p.title, p.description, p.speech, ...p.said.flat(), ...Object.values(p.screen), ...p.tags].join("\n");
    assert.doesNotMatch(text, PROIBIDO, `${day} ${slot}`);
    for (const ch of ["instagram", "facebook", "tiktok"]) assert.doesNotMatch(captionFor(p, ch, { salesOpen: p.purchase === "hotmart" }), PROIBIDO, ch);
  }
});

test("CTA: /hotmart/<slug> com UTM no modo Hotmart; calculadora gratuita com UTM com a compra fechada; nunca /comprar/ nem a página com lista de espera", () => {
  for (const day of days(14)) {
    const hm = planSlot(day, "oferta", { hotmartOpen: true });
    assert.match(hm.link, /^https:\/\/vendas\.zevanory\.api\.br\/hotmart\/[a-z-]+\?utm_source=youtube&utm_medium=/);
    assert.equal(ctaPermitido(hm.link, { hotmartOpen: true }).tipo, "hotmart");
    assert.match(planSlot(day, "dica", { hotmartOpen: true }).link, /^https:\/\/vendas\.zevanory\.api\.br\/hotmart\/ia-na-pratica\?utm_source=youtube&utm_medium=short&utm_campaign=dica_/);
    for (const slot of SLOTS) {
      const fechado = planSlot(day, slot);
      assert.match(fechado.link, /^https:\/\/vendas\.zevanory\.api\.br\/calculadora-[a-z-]+\?utm_source=youtube&utm_medium=short&utm_campaign=[a-z_-]+$/, slot);
      assert.ok(fechado.description.includes(fechado.link)); assert.doesNotMatch(fechado.description + fechado.speech, /R\$/);
    }
    // Interruptor completo (checkout próprio) contraria a trava: o Short de oferta é descartado, nunca linka /comprar/.
    const proprio = planSlot(day, "oferta", { salesOpen: true });
    assert.equal(proprio.gate.action, "discard"); assert.match(proprio.gate.reason, /cta_fora_da_politica/);
  }
  const ok = "https://vendas.zevanory.api.br/calculadora-cmv?utm_source=youtube&utm_medium=short&utm_campaign=calc_cmv";
  assert.equal(ctaPermitido(ok).ok, true);
  for (const [bad, motivo] of [
    ["https://vendas.zevanory.api.br/comprar/ZEV-IA-011?utm_source=youtube&utm_medium=short&utm_campaign=x", "cta_fora_da_politica"],
    ["https://vendas.zevanory.api.br/ia-para-padaria?utm_source=youtube&utm_medium=short&utm_campaign=x", "cta_fora_da_politica"],
    ["https://vendas.zevanory.api.br/hotmart/ia-na-pratica?utm_source=youtube&utm_medium=short&utm_campaign=x", "cta_hotmart_com_modo_hotmart_fechado"],
    ["https://vendas.zevanory.api.br/calculadora-cmv", "cta_sem_utm"],
    ["https://vendas.zevanory.api.br/calculadora-cmv?utm_source=blog&utm_medium=short&utm_campaign=x", "cta_sem_utm"],
    ["http://vendas.zevanory.api.br/calculadora-cmv?utm_source=youtube&utm_medium=short&utm_campaign=x", "cta_fora_do_site_de_vendas"],
    ["https://evil.example/calculadora-cmv?utm_source=youtube&utm_medium=short&utm_campaign=x", "cta_fora_do_site_de_vendas"],
    ["nao e url", "cta_invalido"]]) assert.equal(ctaPermitido(bad).motivo, motivo, bad);
});

const hist = (lista) => Object.fromEntries(lista.map(([d, publicados, extra = {}]) => [d, { publicados, ...extra }]));
test("rampa: 1/dia nos primeiros 7 dias; 2/dia após 7 dias limpos; 3/dia após mais 7; publicações de outubro não contam", () => {
  assert.deepEqual(nivelRampa({ config: CFG, dia: "2026-11-10" }), { nivel: 1, por_dia: 1, slots: ["dica"], dias_limpos: 0, motivo: "nivel_1" });
  const d = days(15);
  assert.equal(nivelRampa({ config: CFG, dia: d[7], historico: hist(d.slice(0, 6).map((x) => [x, 1])) }).nivel, 1, "6 dias limpos: continua 1/dia");
  const n2 = nivelRampa({ config: CFG, dia: d[7], historico: hist(d.slice(0, 7).map((x) => [x, 1])) });
  assert.equal(n2.nivel, 2); assert.equal(n2.por_dia, 2); assert.deepEqual(n2.slots, ["dica", "calc"]);
  // No nível 2, um dia com só 1 Short não é limpo: zera a contagem.
  const parcial = hist([...d.slice(0, 7).map((x) => [x, 1]), ...d.slice(7, 14).map((x, i) => [x, i === 3 ? 1 : 2])]);
  assert.equal(nivelRampa({ config: CFG, dia: d[14], historico: parcial }).nivel, 2);
  const n3 = nivelRampa({ config: CFG, dia: d[14], historico: hist([...d.slice(0, 7).map((x) => [x, 1]), ...d.slice(7, 14).map((x) => [x, 2])]) });
  assert.equal(n3.nivel, 3); assert.equal(n3.por_dia, 3); assert.deepEqual(n3.slots, ["dica", "calc", "oferta"]);
  // Outubro (3 Shorts/dia de 12 a 22/10) está antes de contar_a_partir_de: não sobe a rampa da retomada.
  const outubro = hist(days(11, "2026-10-12").map((x) => [x, 3]));
  assert.equal(nivelRampa({ config: CFG, dia: "2026-11-10", historico: outubro }).nivel, 1);
  assert.ok(diasDaJanela(CFG, "2026-11-12").every((x) => x >= "2026-11-10"));
  assert.ok(diasDaJanela(CFG, "2027-02-01").length <= CFG.janela_maxima_dias);
});

test("rampa: falha de QC de áudio/vídeo desce um nível; aviso do canal não deixa subir e zera os slots do dia", () => {
  const d = days(16);
  const base = [...d.slice(0, 7).map((x) => [x, 1]), ...d.slice(7, 14).map((x) => [x, 2])];
  const comQc = hist(base.map(([x, n]) => (x === d[13] ? [x, 0, { qc_falha: true }] : [x, n])));
  assert.equal(nivelRampa({ config: CFG, dia: d[14], historico: comQc }).nivel, 1, "QC falhou no nível 2: volta ao 1");
  const comAviso = hist(base.map(([x, n]) => (x === d[13] ? [x, 2, { aviso: true }] : [x, n])));
  assert.equal(nivelRampa({ config: CFG, dia: d[14], historico: comAviso }).nivel, 2, "aviso no 7º dia: não sobe");
  const hoje = nivelRampa({ config: CFG, dia: d[14], historico: hist(base), avisoHoje: true });
  assert.deepEqual(hoje.slots, []); assert.equal(hoje.por_dia, 0); assert.equal(hoje.motivo, "canal_com_aviso");
  assert.equal(eQcFalha("audio_qc_failed:loudness_-27"), true); assert.equal(eQcFalha("youtube_black_frames_detected"), true);
  assert.equal(eQcFalha("youtube_mp4_technical_gate_failed"), true); assert.equal(eQcFalha("voz_indisponivel"), false);
});

test("decisão do slot: só os slots do nível, no máximo por_dia Shorts no dia, nada com o canal congelado", () => {
  const r1 = nivelRampa({ config: CFG, dia: "2026-11-10" });
  assert.deepEqual(decisaoSlot({ rampa: r1, slot: "dica" }), { publicar: true, motivo: "rampa_ok" });
  assert.equal(decisaoSlot({ rampa: r1, slot: "oferta" }).motivo, "slot_fora_da_rampa");
  assert.equal(decisaoSlot({ rampa: r1, slot: "calc" }).motivo, "slot_fora_da_rampa");
  assert.equal(decisaoSlot({ rampa: r1, slot: "dica", publicadosHoje: 1 }).motivo, "limite_diario_da_rampa");
  assert.equal(decisaoSlot({ rampa: r1, slot: "dica", congelado: true }).motivo, "canal_congelado");
  assert.equal(decisaoSlot({ rampa: { slots: ["dica", "calc"], por_dia: 2 }, slot: "calc", publicadosHoje: 1 }).publicar, true);
});

const chan = (status, id = CANAL_ESPERADO) => ({ ok: true, status: 200, json: { items: [{ id, status }] } });
test("preflight do canal: público só sem restrição; restrição congela; falha da API só pula o dia", () => {
  assert.deepEqual(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "allowed", madeForKids: false })), { estado: "ok", motivos: [] });
  assert.equal(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "eligible" })).estado, "ok");
  assert.deepEqual(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "disallowed" })), { estado: "restricao", motivos: ["recursos_intermediarios_revogados"] });
  assert.equal(avaliarPreflight(chan({ privacyStatus: "private", longUploadsStatus: "allowed" })).estado, "restricao");
  assert.equal(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "allowed", madeForKids: true })).estado, "restricao");
  assert.deepEqual(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "allowed" }, "UCoutro")).motivos, ["canal_divergente"]);
  assert.equal(avaliarPreflight({ ok: false, status: 503 }).estado, "indisponivel");
  assert.equal(avaliarPreflight(null).estado, "indisponivel");
  assert.equal(avaliarPreflight(chan(undefined)).estado, "indisponivel");
  assert.equal(avaliarPreflight(chan({ privacyStatus: "public" })).estado, "indisponivel", "sem sinal de recursos: não publica, não congela");
  assert.deepEqual(avaliarPreflight(chan({ privacyStatus: "public", longUploadsStatus: "allowed" }), { avisoManual: true }).motivos, ["aviso_manual_do_proprietario"]);
  assert.equal(avaliarPosUpload({ privacy_status: "public" }).estado, "ok");
  assert.equal(avaliarPosUpload({ privacy_status: "private" }).estado, "restricao");
  assert.equal(avaliarPosUpload({ privacy_status: "unlisted" }).estado, "restricao");
});

test("preflight real usa channels?part=id,status (somente leitura) e congela no máximo uma vez; liberação só por data >= desde", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push([String(url), init.method || "GET"]); return { ok: true, status: 200, json: async () => ({ items: [{ id: CANAL_ESPERADO, status: { privacyStatus: "public", longUploadsStatus: "disallowed" } }] }) }; };
  const pf = await preflightCanal({ accessToken: "t", fetchImpl });
  assert.equal(pf.estado, "restricao"); assert.deepEqual(calls, [["https://www.googleapis.com/youtube/v3/channels?part=id,status&mine=true", "GET"]]);
  const down = await preflightCanal({ accessToken: "t", fetchImpl: async () => { throw new Error("net"); } });
  assert.equal(down.estado, "indisponivel");
  const kv = memKv();
  assert.equal((await congelarCanal(kv, "2026-11-12", pf.motivos)).gravado, true);
  assert.equal((await congelarCanal(kv, "2026-11-13", pf.motivos)).gravado, false);
  assert.equal(kv.puts, 1, "uma gravação só");
  const reg = JSON.parse(kv.m.get(CHAVE_CONGELADO));
  assert.equal(reg.desde, "2026-11-12");
  assert.equal(congelamentoAtivo({ config: CFG, registro: reg }), true);
  assert.equal(congelamentoAtivo({ config: { canal: { congelamento_liberado_em: "2026-11-11" } }, registro: reg }), true, "liberação anterior ao congelamento não vale");
  assert.equal(congelamentoAtivo({ config: { canal: { congelamento_liberado_em: "2026-11-12" } }, registro: reg }), false);
  assert.equal(congelamentoAtivo({ config: CFG, registro: null }), false);
  const kv2 = memKv();
  assert.equal((await gravarUmaVez(kv2, "k", { a: 1 })).gravado, true); assert.equal((await gravarUmaVez(kv2, "k", { a: 2 })).motivo, "ja_registrado");
  assert.equal(kv2.puts, 1); assert.equal((await gravarUmaVez(null, "k", {})).motivo, "sem_kv");
});

test("histórico da rampa só conta Shorts públicos e lê falhas de QC; erro de leitura volta ao nível 1", async () => {
  const kv = memKv();
  const put = (d, k, privacy) => kv.m.set(`zpc:acquisition:daily:${d}:${k}`, JSON.stringify({ status: "publicado", privacy }));
  put("2026-11-10", "youtube_dica", "public"); put("2026-11-10", "youtube_calc", "private"); put("2026-11-11", "youtube_dica", "public");
  kv.m.set("zpc:shorts:qc:2026-11-11", "{}");
  const h = await historicoRampa(kv, CFG, "2026-11-12");
  assert.deepEqual(h, { "2026-11-10": { publicados: 1, qc_falha: false }, "2026-11-11": { publicados: 1, qc_falha: true } });
  assert.deepEqual(await historicoRampa({ get: async () => { throw new Error("kv_get_http_500"); } }, CFG, "2026-11-12"), {});
  assert.deepEqual(await publicadosNoDia(kv, "2026-11-10"), { dica: true, calc: true, oferta: false });
});

const at = (iso) => Date.parse(iso);
const SHORT_WF = "youtube-autonomous-short.yml";
test("dispatcher: workflow desativado não é disparado (sem 422); estado desconhecido só 1 tentativa por hora; outros motores seguem", () => {
  const now = at("2026-11-10T14:30:00Z"); // 11:30 em Brasília
  const off = decide({ now, workflowStates: { [SHORT_WF]: "disabled_manually", "short-pack.yml": "disabled_manually" } });
  assert.ok(!off.some((e) => e.workflow === SHORT_WF), "nenhum POST para o workflow desativado");
  assert.ok(off.some((e) => e.id === "command-center"), "motores ativos continuam");
  assert.ok(decide({ now, workflowStates: { [SHORT_WF]: "active" } }).some((e) => e.id === "short-dica"));
  assert.deepEqual(workflowGate("disabled_manually", 5), { dispatch: false, status: "workflow_disabled_manually" });
  assert.deepEqual(workflowGate("disabled_inactivity", 5), { dispatch: false, status: "workflow_disabled_inactivity" });
  // Desconhecido: nos minutos 0-19 de cada hora (uma execução do cron 7/27/47), nunca nos outros.
  assert.ok(decide({ now: at("2026-11-10T14:07:00Z"), workflowStates: { [SHORT_WF]: "unknown" } }).some((e) => e.id === "short-dica"));
  for (const m of ["27", "47"]) assert.ok(!decide({ now: at(`2026-11-10T14:${m}:00Z`), workflowStates: { [SHORT_WF]: "unknown" } }).some((e) => e.workflow === SHORT_WF), m);
  let ticks = 0; for (let m = 0; m < 60; m++) if (workflowGate("unknown", 14 * 60 + m).dispatch) ticks++;
  assert.equal(ticks, 20, "uma janela de 20 min por hora = um tique do cron 7/27/47");
});

test("dispatcher: só dispara os slots da rampa; canal congelado = nenhum Short", () => {
  const late = at("2026-11-10T23:30:00Z"); // 20:30 em Brasília: os três slots já venceram
  const ids = (shortSlots) => decide({ now: late, shortSlots, kvDone: {} }).filter((e) => e.workflow === SHORT_WF).map((e) => e.id);
  assert.deepEqual(ids(["dica"]), ["short-dica"]);
  assert.deepEqual(ids([]), []);
  assert.deepEqual(decide({ now: late, shortSlots: ["dica"], kvDone: { youtube_dica: true } }).filter((e) => e.workflow === SHORT_WF), [], "dica feito: oferta e calc fora da rampa não disparam");
  assert.deepEqual(shortSlotsAllowed({ config: CFG, dia: "2026-11-10" }), { slots: ["dica"], motivo: "nivel_1_padrao" });
  assert.deepEqual(shortSlotsAllowed({ config: CFG, dia: "2026-11-20", statusDia: { day: "2026-11-20", slots: ["dica", "calc"], estado: "ativo" } }).slots, ["dica", "calc"]);
  assert.deepEqual(shortSlotsAllowed({ config: CFG, dia: "2026-11-21", statusDia: { day: "2026-11-20", slots: ["dica", "calc"] } }).slots, ["dica"], "registro de outro dia não vale");
  assert.deepEqual(shortSlotsAllowed({ config: CFG, dia: "2026-11-20", congelamento: { desde: "2026-11-15" } }), { slots: [], motivo: "canal_congelado" });
  assert.deepEqual(shortSlotsAllowed({ config: { ...CFG, canal: { congelamento_liberado_em: "2026-11-16" } }, dia: "2026-11-20", congelamento: { desde: "2026-11-15" } }).slots, ["dica"]);
  assert.deepEqual(shortSlotsAllowed({ config: { ...CFG, canal: { aviso_manual: true } }, dia: "2026-11-20" }).slots, []);
});

test("o workflow do Short e o short-pack não são reativados nem alterados por este PR (estado do proprietário)", () => {
  const wf = readFileSync(new URL("../.github/workflows/youtube-autonomous-short.yml", import.meta.url), "utf8");
  assert.match(wf, /node scripts\/channels\/youtube-daily-short\.mjs/);
  const disp = readFileSync(new URL("../scripts/ops/engine-dispatcher.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(disp, /\/enable["`]/, "o dispatcher nunca chama a API de reativação");
});
