// P13 Pós-venda: ENSAIO SINTÉTICO da política de 7 dias, do procedimento de contestação 7.3 e do pacote de
// respostas (roteiro v4.9.1, seções 5, 6.4, 7.1 H-6, 7.3 e 12-B.4). Rótulo: SINTÉTICA. Sem rede, sem produção, sem
// reembolso real ou fabricado, sem dado pessoal (valores sintéticos). Relatório: docs/p13/ensaio-politica-7d.md.
// Marcadores [Vn.k] usados pelos mutantes (scripts/ci/mutants_p13_posvenda.py).
import test from "node:test";
import assert from "node:assert/strict";
import { readTextNormalized } from "./helpers/text.mjs";
import { decidirReembolso, excecaoValida, HOTMART_RESPOSTA_DIAS } from "../scripts/p13/decisao-reembolso-7d.mjs";
import { novaContestacao, avancar, ContestacaoError, mascararEmail, problemasDePrivacidade } from "../scripts/p13/contestacao-7-3.mjs";
import { checkPack, parsePack, DECISOES } from "../scripts/p13/respostas-check.mjs";

const DAY = 86_400_000, HOUR = 3_600_000;
const T0 = Date.parse("2026-11-02T15:00:00Z"); // 12:00 em Brasília
const FIM = Date.parse("2026-11-10T02:59:59.999Z"); // 09/11 23:59:59.999 em Brasília (7º dia corrido seguinte)
const pago = (extra = {}) => ({ aprovado_em: T0, estado: "pago", ...extra });
const pedido = (solicitado_em, extra = {}) => ({ solicitado_em, canal: "hotmart", protocolo: "ZV-P13-000001", motivo: "arrependimento", ...extra });
const decide = (p, s, extra = {}) => decidirReembolso({ pedido: p, solicitacao: s, agora: s.solicitado_em, ...extra });
const PACK = readTextNormalized(new URL("../docs/p13/respostas-prontas.md", import.meta.url));

test("V1 dentro do prazo na Hotmart (DEC-06: recebimento = aprovação): aprovar integral, sem justificativa, prazos registrados", () => {
  const d = decide(pago(), pedido(T0 + 3 * DAY));
  assert.equal(d.decisao, "aprovar_arrependimento", "[V1.1] aprovar");
  assert.equal(d.integral, true, "[V1.2] devolução integral");
  assert.equal(d.pedir_justificativa, false, "[V1.3] sem pedir justificativa");
  assert.equal(d.revisao_humana, false, "[V1.4] regra aplicada sem decisão sensível");
  assert.equal(d.prazos.resposta_hotmart_ate, new Date(T0 + 3 * DAY + 5 * DAY).toISOString(), "[V1.5] resposta na Hotmart em 5 dias corridos (H-6)");
  assert.equal(HOTMART_RESPOSTA_DIAS, 5, "[V1.6] prazo H-6 registrado");
  assert.deepEqual(d.alimenta, ["P24", "P25"], "[V1.7] motivos alimentam P24 e P25");
});

test("V2 limites do prazo: último instante do 7º dia aprova; 1 ms depois não", () => {
  assert.equal(decide(pago(), pedido(FIM)).decisao, "aprovar_arrependimento", "[V2.1] último instante");
  assert.equal(decide(pago(), pedido(FIM + 1)).decisao, "fora_do_prazo", "[V2.2] primeiro instante do 8º dia");
  assert.equal(decide(pago(), pedido(T0 + 7 * DAY)).decisao, "aprovar_arrependimento", "[V2.3] nunca menos que 7 × 24 h");
});

test("V3 pedido feito durante indisponibilidade: o prazo é medido na SOLICITAÇÃO, não no tratamento (12-B.4)", () => {
  const s = pedido(T0 + 6 * DAY);
  const d = decidirReembolso({ pedido: pago(), solicitacao: s, agora: T0 + 12 * DAY });
  assert.equal(d.decisao, "aprovar_arrependimento", "[V3.1] tratado no dia 12, pedido no dia 6: aprova");
  assert.ok(d.alertas.includes("prazo_hotmart_h6_estourado"), "[V3.2] alerta de prazo H-6 vencido");
  assert.ok(d.alertas.includes("prazo_resposta_conclusiva_estourado"), "[V3.3] alerta de resposta conclusiva vencida");
});

test("V4 já reembolsado, em andamento ou cancelado: nunca uma segunda reversão", () => {
  assert.equal(decide(pago({ estado: "reembolsado" }), pedido(T0 + DAY)).decisao, "ja_reembolsado", "[V4.1] já reembolsado");
  assert.equal(decide(pago({ estado: "reembolso_em_andamento" }), pedido(T0 + DAY)).decisao, "em_andamento", "[V4.2] em andamento");
  assert.equal(decide(pago({ estado: "cancelado" }), pedido(T0 + DAY)).decisao, "ja_cancelado", "[V4.3] cancelado");
});

test("V5 pedido duplicado: devolve a decisão registrada, sem recalcular", () => {
  const primeira = decide(pago(), pedido(T0 + 2 * DAY));
  const repetida = decidirReembolso({ pedido: pago(), solicitacao: pedido(T0 + 20 * DAY, { canal: "suporte_email" }), decisaoAnterior: primeira, agora: T0 + 20 * DAY });
  assert.equal(repetida.decisao, "aprovar_arrependimento", "[V5.1] a decisão registrada vale");
  assert.equal(repetida.duplicado, true, "[V5.2] marcada como duplicada");
  assert.equal(repetida.prazos.resposta_hotmart_ate, primeira.prazos.resposta_hotmart_ate, "[V5.3] prazos originais");
});

test("V6 contestação aberta: segue o 7.3, sem reembolso paralelo, com revisão humana", () => {
  const d = decide(pago({ estado: "contestado" }), pedido(T0 + DAY));
  assert.equal(d.decisao, "contestacao_em_andamento", "[V6.1] contestação");
  assert.equal(d.revisao_humana, true, "[V6.2] revisão humana");
});

test("V7 fora do prazo: sem reembolso automático; vício vai à revisão; exceção só com autorização registrada", () => {
  const fora = decide(pago(), pedido(T0 + 10 * DAY));
  assert.equal(fora.decisao, "fora_do_prazo", "[V7.1] fora do prazo");
  assert.equal(decide(pago(), pedido(T0 + 10 * DAY, { motivo: "defeito" })).decisao, "fora_do_prazo_vicio", "[V7.2] vício vai à análise");
  assert.equal(decide(pago(), pedido(T0 + 10 * DAY, { motivo: "defeito" })).revisao_humana, true, "[V7.3] vício com revisão humana");
  const semAut = decide(pago(), pedido(T0 + 10 * DAY), { excecao: { autorizada_por: "suporte", registro: "pedido do atendente", motivo: "cliente insistiu muito" } });
  assert.equal(semAut.decisao, "excecao_nao_autorizada", "[V7.4] exceção sem autorização do proprietário é bloqueada");
  assert.equal(decide(pago(), pedido(T0 + 10 * DAY), { excecao: { autorizada_por: "proprietario", registro: "", motivo: "sem registro algum" } }).decisao, "excecao_nao_autorizada", "[V7.5] exceção sem registro é bloqueada");
  const aut = decide(pago(), pedido(T0 + 10 * DAY), { excecao: { autorizada_por: "proprietario", registro: "DEC-P13-0001", motivo: "falha de acesso comprovada" } });
  assert.equal(aut.decisao, "excecao_autorizada", "[V7.6] exceção autorizada e registrada");
  assert.equal(aut.excecao_registro, "DEC-P13-0001", "[V7.7] registro anexado");
  assert.equal(aut.revisao_humana, true, "[V7.8] exceção sempre com revisão humana");
  assert.equal(excecaoValida(null), false, "[V7.9] sem exceção");
});

test("V8 assunto jurídico ou dado pessoal: revisão humana obrigatória mesmo dentro do prazo", () => {
  const d = decide(pago(), pedido(T0 + DAY, { motivo: "juridico" }));
  assert.equal(d.decisao, "aprovar_arrependimento", "[V8.1] o direito continua");
  assert.equal(d.revisao_humana, true, "[V8.2] revisão humana");
  assert.equal(decide(pago(), pedido(T0 + DAY, { motivo: "dado_pessoal" })).revisao_humana, true, "[V8.3] dado pessoal");
});

test("V9 dados incoerentes: inválido com revisão, nunca uma decisão automática", () => {
  assert.equal(decide(pago(), pedido(T0 - HOUR)).decisao, "invalido", "[V9.1] pedido antes da aprovação");
  assert.equal(decide(pago(), pedido(T0 + DAY, { protocolo: "x" })).decisao, "invalido", "[V9.2] protocolo inválido");
  assert.equal(decide(pago(), pedido(T0 + DAY, { canal: "whatsapp" })).decisao, "invalido", "[V9.3] canal fora da lista");
  assert.equal(decide(pago({ estado: "qualquer" }), pedido(T0 + DAY)).revisao_humana, true, "[V9.4] estado desconhecido vai à revisão");
});

test("V10 checkout próprio legado: entrega atrasada conta do recebimento", () => {
  const p = pago({ recebido_em: T0 + 5 * DAY });
  assert.equal(decide(p, pedido(T0 + 10 * DAY, { canal: "pedir_reembolso" })).decisao, "aprovar_arrependimento", "[V10.1] dia 10 da compra, dia 5 do recebimento: aprova");
  assert.equal(decide(p, pedido(T0 + 10 * DAY, { canal: "pedir_reembolso" })).prazos.resposta_hotmart_ate, null, "[V10.2] sem prazo Hotmart fora da Hotmart");
});

test("V11 contestação 7.3, caminho completo: aviso, protocolo, evidência mascarada, resposta revisada no prazo, resultado", () => {
  let c = novaContestacao();
  c = avancar(c, "receber_aviso", { agora: T0, plataforma: "hotmart" });
  c = avancar(c, "registrar", { agora: T0 + HOUR, protocolo: "ZV-DSP-000001", prazo_plataforma_ate: T0 + 5 * DAY });
  const ev = [{ tipo: "registro_acesso", texto: "acesso liberado em 2026-11-02 12:01 BRT ao comprador " + mascararEmail("comprador@example.invalid") },
    { tipo: "politica_publicada", texto: "arrependimento em 7 dias corridos; suporte@zevanory.api.br" }];
  c = avancar(c, "reunir_evidencia", { agora: T0 + 2 * HOUR, itens: ev });
  assert.equal(c.estado, "evidencia_reunida", "[V11.1] evidência aceita");
  c = avancar(c, "responder", { agora: T0 + DAY, revisado_por: "proprietario" });
  assert.equal(c.estado, "respondida", "[V11.2] respondida no prazo");
  c = avancar(c, "registrar_resultado", { agora: T0 + 9 * DAY, resultado: "favoravel" });
  assert.equal(c.estado, "encerrada", "[V11.3] encerrada");
  assert.deepEqual(c.alimenta, ["P24", "P25"], "[V11.4] alimenta P24 e P25");
  assert.deepEqual(c.historico.map((h) => h.tipo), ["aviso_recebido", "registrada", "evidencia_reunida", "respondida", "encerrada"], "[V11.5] trilha completa");
  assert.ok(!JSON.stringify(c).includes("comprador@example"), "[V11.6] nenhum e-mail em claro");
});

test("V12 contestação 7.3, negativos: privacidade, evidência, prazo, revisão humana, falha crítica de P12 e suspensão", () => {
  const reg = () => avancar(avancar(novaContestacao(), "receber_aviso", { agora: T0, plataforma: "hotmart" }), "registrar", { agora: T0, protocolo: "ZV-DSP-000002", prazo_plataforma_ate: T0 + 5 * DAY });
  const code = (fn) => { try { fn(); return "ok"; } catch (e) { return e instanceof ContestacaoError ? e.code : "erro"; } };
  assert.equal(code(() => avancar(reg(), "reunir_evidencia", { agora: T0, itens: [{ tipo: "registro_envio", texto: "enviado a comprador@example.invalid" }] })), "dado_pessoal_em_claro", "[V12.1] e-mail em claro recusado");
  assert.equal(code(() => avancar(reg(), "reunir_evidencia", { agora: T0, itens: [{ tipo: "comunicacao", texto: "conversa" }] })), "sem_evidencia_de_entrega", "[V12.2] sem evidência de entrega");
  assert.equal(code(() => avancar(avancar(novaContestacao(), "receber_aviso", { agora: T0, plataforma: "hotmart" }), "registrar", { agora: T0, protocolo: "ZV-DSP-000003" })), "prazo_da_plataforma_nao_registrado", "[V12.3] prazo da plataforma obrigatório");
  const comEv = () => avancar(reg(), "reunir_evidencia", { agora: T0, itens: [{ tipo: "registro_acesso", texto: "acesso liberado" }] });
  assert.equal(code(() => avancar(comEv(), "responder", { agora: T0 + DAY })), "revisao_humana_obrigatoria", "[V12.4] resposta sem revisão humana recusada");
  assert.equal(avancar(comEv(), "responder", { agora: T0 + 6 * DAY, revisado_por: "proprietario" }).estado, "prazo_perdido", "[V12.5] resposta depois do prazo vira prazo perdido");
  const perdida = avancar(avancar(comEv(), "responder", { agora: T0 + DAY, revisado_por: "proprietario" }), "registrar_resultado", { agora: T0 + 9 * DAY, resultado: "desfavoravel", causa: "falha_entrega" });
  assert.equal(perdida.falha_critica, "P12", "[V12.6] perdida por falha de entrega = falha crítica de P12");
  assert.equal(code(() => avancar(comEv(), "suspender_acesso", { agora: T0, revisado_por: "proprietario" })), "suspensao_sem_base_na_politica", "[V12.7] suspensão sem base na política recusada");
  assert.equal(code(() => avancar(avancar(novaContestacao(), "receber_aviso", { agora: T0, plataforma: "hotmart" }), "receber_aviso", { agora: T0, plataforma: "hotmart" })), "aviso_repetido", "[V12.8] aviso repetido não duplica");
  assert.deepEqual(problemasDePrivacidade("CPF 123.456.789-09, tel (88) 99999-0000"), ["cpf", "telefone"], "[V12.9] detector de CPF e telefone");
});

test("V13 pacote de respostas: sem dado pessoal, com protocolo, revisão humana marcada e política única", () => {
  const r = checkPack(PACK);
  assert.deepEqual(r.problemas, [], "[V13.1] pacote aprovado pelo verificador");
  assert.equal(r.total, 13, "[V13.2] 6 Reclame Aqui + 4 consumidor.gov.br + 3 Hotmart");
  const ts = parsePack(PACK);
  for (const t of ts) assert.ok(DECISOES.has(t.decisao), `[V13.3] ${t.id}: decisão conhecida`);
  const mut = (from, to) => checkPack(PACK.replace(from, to)).problemas;
  assert.ok(mut("escreva para suporte@zevanory.api.br informando o protocolo", "escreva para fulano@example.com informando o protocolo").includes("RA-01:email_nao_oficial"), "[V13.4] e-mail não oficial recusado");
  assert.ok(mut("Protocolo: {PROTOCOLO}. O estorno", "Protocolo: {PROTOCOLO}, cliente {NOME}. O estorno").includes("RA-02:campo_nao_permitido:NOME"), "[V13.5] campo fora da lista recusado");
  assert.ok(mut("- Revisão humana: OBRIGATÓRIA (resposta pública)\n```text\nOlá. Sentimos", "- Revisão humana: dispensada (teste)\n```text\nOlá. Sentimos").includes("RA-01:publica_sem_revisao_obrigatoria"), "[V13.6] resposta pública exige revisão");
  assert.ok(mut("- Revisão humana: OBRIGATÓRIA (contestação)\n```text\nDisputa", "- Revisão humana: dispensada (teste)\n```text\nDisputa").includes("HM-03:sensivel_sem_revisao_obrigatoria"), "[V13.7] decisão sensível exige revisão");
  assert.ok(mut("e esse prazo terminou em {PRAZO}", "e esse prazo de 7 dias contados da compra terminou em {PRAZO}").length > 0, "[V13.8] prazo diferente da política recusado");
  assert.ok(mut("O direito de arrependimento vale por 7 dias corridos contados da assinatura do contrato ou do recebimento do produto ou serviço (a data mais recente, se diferentes), e esse", "O direito de arrependimento vale por 7 dias, e esse").includes("RA-03:prazo_diferente_da_politica"), "[V13.9] texto do prazo fora da política única");
  assert.ok(mut("com devolução integral. Protocolo interno: {PROTOCOLO}.", "com devolução integral de R$ 97. Protocolo interno: {PROTOCOLO}.").includes("HM-01:preco"), "[V13.10] valor recusado");
});

test("V14 procedimento 7.3 documentado com as seis etapas e a regra de suspensão", () => {
  const doc = readTextNormalized(new URL("../docs/p13/procedimento-contestacao-7-3.md", import.meta.url));
  for (const etapa of ["Receber o aviso", "Registrar com protocolo", "Reunir a evidência de entrega", "Responder dentro do prazo", "Registrar o resultado", "Alimentar P24 e P25"])
    assert.ok(doc.includes(etapa), `[V14.1] etapa: ${etapa}`);
  assert.ok(doc.includes("falha crítica de P12"), "[V14.2] regra da falha crítica");
  assert.ok(doc.includes("REVISÃO HUMANA OBRIGATÓRIA"), "[V14.3] marcação de revisão humana");
});
