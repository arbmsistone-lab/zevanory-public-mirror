#!/usr/bin/env python3
"""Mutantes do Conteúdo Pronto (roteiros multicanal, schema versionado; AVAL Sol #898).

Cada mutante altera UMA CÓPIA temporária da árvore (oferta, contrato, gerador, páginas-fonte ou geradas), roda
tests/conteudo-pronto-roteiros.test.mjs e tests/content-service.test.mjs contra a cópia e classifica o resultado
com o classificador COMPARTILHADO scripts/ci/mutant_classifier.py (classify_run; meta-testes em
tests/test_mutant_classifier.py e `mutant_classifier.py self-check`). O mapa causal
(scripts/ci/mutants_conteudo_pronto_causality.py, por raciocínio) é traduzido para o formato do classificador
({primary: [{test_pattern, assertion_pattern}], secondary: [{..., justification}], broad_reason}) e validado por
load_mutant_config antes de qualquer mutante:
  KILLED       resumo TAP completo e coerente com a baseline, ao menos uma falha de ASSERÇÃO PRIMARY (teste + rótulo
               dentro do bloco `not ok`) e toda outra falha em PRIMARY ou em SECONDARY justificada;
  SURVIVED     rc == 0 e resumo TAP completo igual à baseline;
  INCONCLUSIVE qualquer outra coisa (queda, erro de sintaxe/módulo, tempo esgotado, contagem incompleta, falha fora
               de PRIMARY/SECONDARY, rótulo fora do bloco `not ok`, trecho não encontrado). Repetido uma vez;
               persistindo, o job falha.
Texto lido em UTF-8 com CRLF normalizado para LF; arquivo mutado gravado em UTF-8/LF; reporter TAP explícito.
Saída: `MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE`. Exit 0 só se todos KILLED; 1 sobrevivente; 3 inconclusivo;
2 baseline falhou; 4 mapa causal inválido (o runner não começa). Uso: python3 scripts/ci/mutants_conteudo_pronto.py [raiz-do-repo]
"""
import os, re, shutil, subprocess, sys, tempfile
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mutant_classifier as mc  # noqa: E402  (classificador compartilhado; meta-testes em tests/test_mutant_classifier.py)
from mutants_conteudo_pronto_causality import CAUSALITY  # noqa: E402  (mapa causal por raciocínio; auditoria Sol 128)
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
REPO = Path(_ARGS[0] if _ARGS else Path(__file__).resolve().parents[2])
TESTS = [Path("tests", "conteudo-pronto-roteiros.test.mjs"), Path("tests", "content-service.test.mjs"), Path("tests", "conteudo-pronto-campanha.test.mjs")]
J = "data/politica-unica.json"
CS = "worker/content-service.mjs"
PG = "conteudo-pronto/index.html"
NODE = shutil.which("node")
TIMEOUT = 600
BASELINE_TESTS = 45  # contagem fixada (o job de contrato confere o mesmo número)

# id -> (arquivo relativo com "/", trecho original (ocorre 1 vez após normalizar EOL), substituto, rótulo da asserção esperada)
M = {
    "M01 oferta volta a WhatsApp (JSON)": (J, "4 roteiros multicanal de venda e acompanhamento — cada um com versão curta e versão de e-mail — e um calendário",
        "4 mensagens de venda para WhatsApp e um calendário", "características essenciais = texto canônico"),
    "M02 hero promete WhatsApp": (PG, "para os canais que seus clientes autorizaram.",
        "para WhatsApp.", "conteudo-pronto/index.html"),
    "M03 item da página volta a WhatsApp": (PG, "<li>4 roteiros multicanal de venda e acompanhamento, cada um com versão curta e versão de e-mail</li>",
        "<li>4 mensagens de venda e acompanhamento para WhatsApp</li>", "conteudo-pronto/index.html"),
    "M04 JSON-LD diverge do texto canônico": (PG, "\"description\": \"Todo mês, uma campanha de promoção de vendas",
        "\"description\": \"Todo mês: uma campanha de promoção de vendas", "JSON-LD = texto canônico"),
    "M05 data-content-schema removido da página": (PG, " data-content-schema=\"3\"",
        "", "página e gerador na mesma versão de schema"),
    "M06 versão sobe só no JSON": (J, "\"content_schema_version\": 3",
        "\"content_schema_version\": 4", "página e gerador na mesma versão de schema"),
    "M07 reativação sem consentimento, sem subir versão": (J, "reativar somente cliente com relacionamento ativo ou consentimento registrado para receber contato",
        "reativar cliente antigo", "contrato mudou: suba content_schema_version"),
    "M08 objetivo renomeado no contrato": (J, "\"id\": \"oferta_solicitada\"",
        "\"id\": \"oferta\"", "contrato mudou: suba content_schema_version"),
    "M09 prompt volta a WhatsApp": (CS, "Crie ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento para o negócio usar em canais",
        "Crie ${N_ROTEIROS} roteiros multicanal de venda e acompanhamento para WhatsApp e canais", "prompt sem WhatsApp"),
    "M10 prompt sem as regras dos objetivos": (CS, "`${i + 1}) \"${o.id}\": ${o.regra}`",
        "`${i + 1}) \"${o.id}\"`", "prompt traz objetivo e regra"),
    "M11 validador ignora a ordem dos objetivos": (CS, "    if (id !== obj.id) return null;\n",
        "", "ordem dos objetivos"),
    "M12 validador de roteiros ignora canal banido": (CS, "    if (FORBIDDEN.test(all) || promessa(all) || contaminated(all)) return null;",
        "    if (FORBIDDEN.test(all) || promessa(all)) return null;", "termo proibido na curta"),
    "M13 validador aceita roteiro sem versão de e-mail": (CS, "if (assunto.length < 5 || assunto.length > 120 || corpo.length < 200 || corpo.length > 1600) return null;",
        "", "versão de e-mail obrigatória"),
    "M14 pacote com versão de schema fixa 1": (CS, "content_schema_version: CONTENT_SCHEMA_VERSION, servico: SERVICO, cycle",
        "content_schema_version: 1, servico: SERVICO, cycle", "[pkg-version]"),
    "M15 calendário com 3 roteiros": (CS, "[0.15, 0.4, 0.65, 0.9].forEach",
        "[0.15, 0.4, 0.65].forEach", "[calendario]"),
    "M16 calendário rotula WhatsApp": (CS, "const CAL_LABEL = { post: \"Post\", roteiro: \"Roteiro\" };",
        "const CAL_LABEL = { post: \"Post\", roteiro: \"WhatsApp\" };", "worker/content-service.mjs sem WhatsApp"),
    "M17 título do pacote volta a MENSAGENS PARA WHATSAPP": (CS, "export const ROTEIROS_TITULO = `${N_ROTEIROS} ROTEIROS MULTICANAL DE VENDA E ACOMPANHAMENTO`;",
        "export const ROTEIROS_TITULO = `${N_ROTEIROS} MENSAGENS PARA WHATS` + `APP`;", "e-mail do pacote"),
    "M18 pacote em texto sem versão de e-mail": (CS, "    if (r.email) lines.push(\"Versão de e-mail:\", `Assunto: ${r.email.assunto}`, r.email.corpo);\n",
        "", "[texto-versao-email]"),
    "M19 HTML entregue sem versão de e-mail": (CS, "<h3>Versão de e-mail</h3>",
        "<h3>E-mail</h3>", "[html-versao-email]"),
    "M20 boas-vindas voltam a WhatsApp": (CS, "Os roteiros são para canais que seus clientes autorizaram, como ${CANAIS_TEXTO}; você revisa",
        "Os roteiros são para WhatsApp; você revisa", "worker/content-service.mjs sem WhatsApp"),
    "M21 formulário volta a WhatsApp (escapado na fonte)": (CS, "(ex.: e-mail, Instagram Direct, Telegram, chat do site)",
        "(Whats\\u0041pp, Instagram, site)", "[form]"),
    "M22 suporte volta a WhatsApp": ("worker/support-knowledge.mjs", "4 roteiros multicanal de venda e acompanhamento (versão curta",
        "4 mensagens de venda para WhatsApp (versão curta", "[suporte]"),
    "M23 catálogo-fonte volta a WhatsApp": ("solucoes/index.html", "<li>4 roteiros multicanal de venda e acompanhamento por mês</li>",
        "<li>4 mensagens de venda para WhatsApp por mês</li>", "[catalogo]"),
    "M24 página gerada desatualizada": ("sales-public/conteudo-pronto.html", "<dd>Todo mês, uma campanha de promoção de vendas",
        "<dd>Todo mês, uma campanha de promoção de vendas com mensagens para WhatsApp,", "gerado: conteudo-pronto"),
    "M25 kit de afiliado volta a mensagens": ("kit-afiliado/index.html", "12 posts e 4 roteiros multicanal de venda no tom do negócio, entregues",
        "12 posts e 4 mensagens de venda no tom do negócio, entregues", "kit-afiliado/index.html"),
    "M26 llms.txt gerado volta a mensagens": ("sales-public/llms.txt", "recebe 12 posts, 4 roteiros multicanal",
        "recebe 12 posts, 4 mensagens de venda", "sales-public/llms.txt"),
    "M27 gerador volta a emitir o campo mensagens": (CS, "posts, roteiros: m, calendario",
        "posts, mensagens: m, roteiros: m, calendario", "campo antigo 'mensagens' não é mais gerado"),
    "M28 objetivo exibido vem do modelo": (CS, "out.push({ objetivo_id: obj.id, objetivo: obj.titulo,",
        "out.push({ objetivo_id: obj.id, objetivo: id,", "objetivo exibido vem do contrato"),
    "M29 legado v1 exibe o tipo antigo do calendário": (CS, "const calLabel = (tipo) => CAL_LABEL[tipo] || \"Roteiro\";",
        "const calLabel = (tipo) => CAL_LABEL[tipo] || (tipo.charAt(0).toUpperCase() + tipo.slice(1));", "[legacy-clean]"),
    "M30 aviso sem a regra de consentimento": (CS, "Use a reativação só com relacionamento ativo ou consentimento registrado. ",
        "", "[aviso]"),
    "M31 guia de nicho (fonte) volta a mensagens": ("ia-para-pizzaria/index.html", "12 posts e 4 roteiros multicanal de venda e acompanhamento",
        "12 posts e 4 mensagens de venda", "roteiros multicanal do contrato — ia-para-pizzaria/index.html"),
    "M32 guia de nicho (gerado) volta a mensagens": ("sales-public/ia-para-barbearia.html", "12 posts e 4 roteiros multicanal de venda e acompanhamento",
        "12 posts e 4 mensagens de venda", "roteiros multicanal do contrato — sales-public/ia-para-barbearia.html"),
    "M33 guia gerado sai da varredura": ("sales-public/ia-para-padaria.html", "Conteúdo Pronto</a>: todo mês, 12 posts",
        "Conteúdo Pronto</a>: todo mês, posts", "entrou na varredura: sales-public/ia-para-padaria.html"),
    "M34 página nova descreve com WhatsApp": ("afiliados/index.html", "inclusive nas renovações do Conteúdo Pronto)",
        "inclusive nas renovações do Conteúdo Pronto: 12 posts e 4 roteiros multicanal ou mensagens para WhatsApp)", "sem mensagens/WhatsApp — afiliados/index.html"),
    "M35 catálogo gerado desatualizado": ("sales-public/solucoes.html", "<li>4 roteiros multicanal de venda e acompanhamento por mês</li>",
        "<li>4 mensagens de venda por mês</li>", "gerado: solucoes"),
    "M36 leitura não bloqueia pacote contaminado": (CS, "  if (packageBlocked(pkg)) {\n    const cand = eligible",
        "  if (false) {\n    const cand = eligible", "[legacy-html-leak]"),
    "M37 detector ignora o calendário": (CS, "  return [...camp, ...posts, ...rots, ...cal]",
        "  return [...camp, ...posts, ...rots]", "[legacy-detect] calendario.tema"),
    "M38 detector ignora hashtags": (CS, "p?.cta, ...(Array.isArray(p?.hashtags) ? p.hashtags : [p?.hashtags]), p?.imagem]",
        "p?.cta, p?.imagem]", "[legacy-detect] posts.hashtags"),
    "M39 detector ignora o objetivo das mensagens": (CS, "flatMap((r) => [r?.objetivo, r?.curta,",
        "flatMap((r) => [r?.curta,", "[legacy-detect] mensagens.objetivo"),
    "M40 número mascarado não detectado": (CS, "  if (MASKED_RES.some((re) => re.test(str))) return true;\n",
        "", "número banido mascarado"),
    "M41 número banido em dígitos (completo ou formatado) não detectado": (CS, "    if (BANNED_NUMBERS.some((n) => d.includes(n.slice(-8)))) return true;\n",
        "", "número banido completo"),
    "M42 wa.me fora dos termos proibidos": (J, "\"wa\\\\.me\",\n",
        "", "[legacy-detect] mensagens.texto × wa.me"),
    "M43 regeneração sobrescreve o pacote antigo": (CS, "      if (!(await kv.get(candidate_key))) await kv.put(candidate_key, stored, { expirationTtl: 400 * DAY });",
        "      await kv.put(record.lastPackage, stored, { expirationTtl: 400 * DAY });", "[legacy-bytes]"),
    "M44 regeneração não é idempotente": (CS, "    if (!packageBlocked(pkg)) return page(\"Pacote atualizado\"",
        "    if (false) return page(\"Pacote atualizado\"", "[regen-idempotent]"),
    "M45 assinante inativo recebe o botão": (CS, "const eligible = found.record.status === \"active\" && Boolean(found.record.briefing);",
        "const eligible = Boolean(found.record.briefing);", "[legacy-inactive]"),
    "M46 pacote em texto não bloqueia": (CS, "  if (packageBlocked(pkg)) return `Seu pacote Conteúdo Pronto",
        "  if (false) return `Seu pacote Conteúdo Pronto", "[legacy-text-leak]"),
    "M47 gerador v2 aceita posts contaminados": (CS, "    if (contaminated([tema, legenda, cta, ...hashtags, imagem].join(\" \"))) return null;\n",
        "", "[posts-guard]"),
    "M48 bloqueio sem oferta de regeneração": (CS, "<button type=\"submit\">Gerar versão nova sem custo</button>",
        "<button type=\"submit\">Atualizar</button>", "[legacy-offer]"),
    "M49 regeneração não aponta para a versão nova": (CS, "{ ...record, lastPackage: cand.candidate_key, blockedPackage: cand.blockedPackage,",
        "{ ...record, blockedPackage: cand.blockedPackage,", "[regen] chave nova com versão"),
    "M50 máscara sem âncora no DDD (falso positivo)": (CS, "\\\\(?${n.slice(2, 4)}\\\\)?",
        "\\\\(?\\\\d{2}\\\\)?", "[number-false-positive]"),
    # Regeneração com entrega confirmada (critério Sol #898): bloqueado/candidato/atual; pending -> accepted -> delivered | dead.
    "M51 regeneração ignora o retorno do envio": (CS, "  if (r.ok) {\n    const accepted",
        "  if (true) {\n    const accepted", "[regen-fail]"),
    "M52 regeneração promove com 2xx (antes da entrega)": (CS, "    await putJson(kv, candKey, accepted);\n",
        "    await putJson(kv, candKey, accepted);\n    await putJson(kv, cand.sub, { ...(await readJson(kv, cand.sub, {})), lastPackage: cand.candidate_key });\n", "[regen-accepted]"),
    "M53 envio sem Idempotency-Key": (CS, ", \"idempotency-key\": idempotencyKey },",
        " },", "[regen-idem]"),
    "M54 Idempotency-Key nova a cada tentativa": (CS, "subject: cand.subject, text: cand.text, idempotencyKey: cand.idempotencyKey }",
        "subject: cand.subject, text: cand.text, idempotencyKey: cand.idempotencyKey + \":\" + rand() }", "[regen-idem]"),
    "M55 429/5xx/tempo esgotado tratados como permanentes": (CS, "transient: resendFailureIsTransient(r.status, data), reason",
        "transient: false, reason", "[regen-fail]"),
    "M56 4xx permanente tratado como temporário": (CS, "  if (!r.transient) return markDead(",
        "  if (false) return markDead(", "[regen-dead]"),
    "M57 dead sem alerta ao proprietário": (CS, "  await ownerAlert(env, \"regeneração do Conteúdo Pronto sem entrega\"",
        "  if (0) await ownerAlert(env, \"regeneração do Conteúdo Pronto sem entrega\"", "[regen-dead] alerta"),
    "M58 dead promovido por delivered tardio": (CS, "  if (cand.delivery === \"dead\") return { promoted: false, reason: \"dead_not_promoted\" };\n",
        "", "[regen-dead] delivered tardio"),
    "M59 delivered duplicado reprocessa": (CS, "  if (cand.delivery === \"delivered\" && cand.promotedAt) return { promoted: false, reason: \"duplicate\" };\n",
        "", "[regen-dup]"),
    "M60 reconciliação promove sem evento delivered": (CS, "    if (ev && DELIVERED_EVENTS.has(ev)) {",
        "    if (ev) {", "[regen-accepted] last_event sent"),
    "M61 reconciliação fora do cron": (CS, "  const regen = await reconcileRegenCandidates(env, fetchImpl).catch(() => ({ ok: false }));",
        "  const regen = { ok: true };", "[regen-cron]"),
    "M62 outro email_id confirma a entrega": (CS, " || String(emailId) !== String(cand.email_id)) return",
        ") return", "[regen-emailid]"),
    "M63 candidato sem sufixo colide com o v2 bloqueado": (CS, " + \":c\" + h.slice(0, 12);",
        ";", "[v2-bytes]"),
    "M64 um candidato novo por tentativa": (CS, "\"|v\" + CONTENT_SCHEMA_VERSION)).slice(0, 40);",
        "\"|v\" + CONTENT_SCHEMA_VERSION + \"|\" + rand())).slice(0, 40);", "[regen-single]"),
    "M65 janela de 23 h ignorada": (CS, "  if (!(now - Date.parse(cand.firstAttemptAt) < REGEN_SEND_WINDOW_HOURS * 3600000)) return markDead(",
        "  if (false) return markDead(", "[regen-window]"),
    "M66 accepted sem prazo de confirmação": (CS, "    else if (!(now - Date.parse(cand.acceptedAt) < REGEN_ACCEPTED_MAX_HOURS * 3600000)) {",
        "    else if (false) {", "[regen-accepted-timeout]"),
    "M67 bounced não vira dead": (CS, "    else if (ev && DEAD_EVENTS.has(ev)) {",
        "    else if (false) {", "[regen-bounce]"),
    "M68 reabrir dead sem operação registrada": (CS, "  if (!String(operator || \"\").trim() || !String(reason || \"\").trim()) return { ok: false, reason: \"operation_must_be_recorded\" };\n",
        "", "[regen-reopen]"),
    "M69 falha de persistência respondida como pendência": (CS, "    } catch { return { ok: false, reason: \"persist_failed\" }; }\n  } else if",
        "    } catch { return { ok: false, reason: \"pending\" }; }\n  } else if", "[regen-persist]"),
    "M70 envia sem outbox durável": (CS, "      await putJson(kv, candKey, cand);\n      await outboxAdd(kv, candKey);\n",
        "      await putJson(kv, candKey, cand);\n      outboxAdd(kv, candKey).catch(() => null);\n", "[regen-persist] outbox"),
    "M71 página afirma entrega com 2xx": (CS, "  if (out.reason === \"accepted\") return [202, REGEN_MSG.accepted];",
        "  if (out.reason === \"accepted\") return [202, REGEN_MSG.delivered];", "[regen-copy]"),
    "M80 accepted responde 200 (entrega não confirmada)": (CS, "  if (out.reason === \"accepted\") return [202, REGEN_MSG.accepted];",
        "  if (out.reason === \"accepted\") return [200, REGEN_MSG.accepted];", "[regen-accepted] POST: 202"),
    "M72 pendência responde 503 em vez de 202": (CS, "  if (out.reason === \"pending\") return [202,",
        "  if (out.reason === \"pending\") return [503,", "[regen-fail] tempo esgotado #1: 202"),
    "M73 queda pós-promoção vira superseded": (CS, "  if (record?.lastPackage === cand.candidate_key) {",
        "  if (false) {", "[regen-converge]"),
    "M74 candidato regravado (não imutável)": (CS, "      if (!(await kv.get(candidate_key))) await kv.put(candidate_key, stored,",
        "      await kv.put(candidate_key, JSON.stringify({ ...JSON.parse(stored), regravado: true }),", "[regen-immutable]"),
    "M75 detector v2 ignora a versão curta": (CS, "flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo])",
        "flatMap((r) => [r?.objetivo, ...(r?.email ? [] : [r?.curta]), r?.email?.assunto, r?.email?.corpo])", "[v2-detect] roteiros.curta"),
    "M76 detector v2 ignora o assunto do e-mail": (CS, "flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo])",
        "flatMap((r) => [r?.objetivo, r?.curta, r?.email?.corpo])", "[v2-detect] roteiros.email.assunto"),
    "M77 detector v2 ignora o corpo do e-mail": (CS, "flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto, r?.email?.corpo])",
        "flatMap((r) => [r?.objetivo, r?.curta, r?.email?.assunto])", "[v2-detect] roteiros.email.corpo"),
    "M78 409 concorrente tratado como permanente (corpo do erro ignorado)": (CS, "transient: resendFailureIsTransient(r.status, data), reason",
        "transient: resendFailureIsTransient(r.status), reason", "[regen-fail] 409 concurrent_idempotent_requests"),
    "M79 POST não converge delivered interrompido": (CS, "  if (cand.delivery === \"delivered\" && !cand.promotedAt) {\n    await applyRegenDelivered(",
        "  if (false) {\n    await applyRegenDelivered(", "[regen-converge] promovido na retomada"),
    # v3 (Sol AVAL 304): campanha mensal de promoção de vendas.
    "M81 período da campanha sem limite": (CS, "  if (!(dias >= CAMPANHA.periodo_dias_min && dias <= CAMPANHA.periodo_dias_max)) return",
        "  if (false) return", "[camp-recusa] 6 dias"),
    "M82 campo da campanha deixa de ser obrigatório": (CS, "      if (v.length < 2) return { ok: false, error: `Faltou preencher",
        "      if (false) return { ok: false, error: `Faltou preencher", "[camp-recusa] sem objetivo_comercial"),
    "M83 campanha aceita promessa de resultado": (CS, "if (FORBIDDEN.test(texto) || CAMPANHA_PROMESSA.test(texto) || promessa(texto) || contaminated(texto))",
        "if (contaminated(texto))", "[camp-recusa] promessa de resultado"),
    "M84 post sem a oferta aceito": (CS, "      if (!anchored(legenda + \" \" + cta, campanha.oferta)) return null;\n",
        "", "[camp-ancora] post sem a oferta"),
    "M85 post sem fase aceito": (CS, "      if (!FASE_IDS.has(fase)) return null;\n",
        "", "[camp-ancora] post sem fase"),
    "M86 e-mail sem a condição comercial aceito": (CS, "      if (!anchored(corpo, campanha.condicao_comercial, { condition: true })) return null;\n",
        "", "[camp-ancora] e-mail sem a condição comercial"),
    "M87 fases da campanha não precisam ser cobertas": (CS, "    return out && FASE_IDS.size === new Set([...a, ...out].map((p) => p.fase)).size ? out : null;",
        "    return out;", "[camp-ancora] fases não cobertas"),
    "M88 calendário sai do período": (CS, "  const at = (f) => Math.round(f * span);",
        "  const at = (f) => Math.round(f * (span + 10));", "[camp-pacote] calendário no período e em ordem"),
    "M89 entrega gera com a campanha do mês anterior": (CS, "  if (record.campanha?.cycle !== cyc || !validateCampaign(record.campanha).ok) return { ok: false, reason: \"campaign_required\" };",
        "", "[camp-renovacao] entrega recusa sem campanha"),
    "M90 renovação não pede a campanha do mês": (CS, "const needsForm = (rec) => !rec.briefing || (campaignTarget(rec) !== null && rec.campanha?.cycle !== campaignTarget(rec));",
        "const needsForm = (rec) => !rec.briefing;", "[camp-renovacao] status"),
    "M91 protocolo do recibo fora do formato": (CS, "protocolo: \"CP-\" + pkgSha.slice(0, 10).toUpperCase()",
        "protocolo: \"CP-\" + pkgSha.slice(0, 6)", "[camp-entrega] protocolo"),
    "M92 evento bounced confirma a entrega": (CS, "    const entregue = Boolean(ev) && DELIVERED_EVENTS.has(ev);",
        "    const entregue = Boolean(ev);", "[camp-entrega] bounced"),
    "M93 recibo sem o id do e-mail": (CS, "sentMark = { at: new Date(now).toISOString(), email_id: typeof sent === \"string\" ? sent : null };",
        "sentMark = { at: new Date(now).toISOString(), email_id: null };", "[camp-entrega] id do e-mail enviado"),
    "M94 serviço deixa de ser campanha no contrato": (J, "\"servico\": \"campanha mensal de promoção de vendas\"",
        "\"servico\": \"pacote mensal de conteúdo\"", "[campanha] serviço"),
    "M95 descrição Hotmart sem a campanha": (J, "\"descricao_hotmart_proposta\": \"ZEVANORY Conteúdo Pronto: campanha mensal de promoção de vendas.",
        "\"descricao_hotmart_proposta\": \"ZEVANORY Conteúdo Pronto: pacote mensal de conteúdo.", "[campanha] descricao_hotmart_proposta"),
    "M96 formulário reaproveita a campanha do mês anterior": (CS, "    const cp = found.record.campanha?.cycle === found.record.cycles ? found.record.campanha : {};",
        "    const cp = found.record.campanha || {};", "[camp-renovacao] campanha do mês anterior não é reaproveitada"),
    "M97 chat deixa passar qualquer promoção": ("worker/site-chat.mjs", "  const nd = n.replace(/campanha (mensal )?de promocao de vendas/g, \"campanha de vendas\");",
        "  const nd = n.replace(/promocao/g, \"\");", "[camp-textos] chat ainda bloqueia"),
    "M98 atendimento deixa passar qualquer promoção": ("worker/whatsapp-conversation.mjs", "  const bodyNoService = body.replace(/campanha (mensal )?de promo[cç][aã]o de vendas/gi, \"campanha de vendas\");",
        "  const bodyNoService = body.replace(/promo[cç][aã]o/gi, \"\");", "[camp-textos] atendimento ainda bloqueia"),
    "M99 confirmação grava a cópia antiga do registro": (CS, "await patchReceipt(kv, key, cycle, { status: \"confirmed\", confirmedAt: new Date(now).toISOString(), provider_event: ev });",
        "await kv.put(key, JSON.stringify({ ...rec, deliveries: { ...rec.deliveries, [cycle]: { ...rcpt, status: \"confirmed\", confirmedAt: new Date(now).toISOString(), provider_event: ev } } }));", "[camp-corrida] cancelamento preservado"),
    "M100 sem lembretes do formulário": (CS, "const due = CAMPAIGN_REMINDER_DAYS.filter(",
        "const due = [].filter(", "[camp-lembretes] um lembrete em cada dia, sem repetir"),
    "M101 lembrete sem alerta ao proprietário": (CS, "if (CAMPAIGN_OWNER_ALERT_DAYS.includes(d)) {",
        "if (false) {", "[camp-lembretes] alerta ao proprietário nos dias 7 e 14"),
    "M102 bounce fora da fila de falhas": (CS, "      await kv.put(PENDING_DEAD, JSON.stringify(dead), { expirationTtl: 400 * DAY });\n      await pendingLog(kv, key, \"delivery_failed\"",
        "      await pendingLog(kv, key, \"delivery_failed\"", "[camp-bounce] falha visível no status"),
    "M103 âncora por substring": (CS, "  if (!(condition ? conditionTerms(ph) : anchorTerms(ph)).length) return false;\n  return new RegExp(",
        "  return normTxt(text).includes(ph);\n  return new RegExp(", "[camp-ancora-vazia] 'Escovação' não ancora 'Escova'"),
    "M104 campanha aceita promessa de resultado": (CS, "CAMPANHA_PROMESSA.test(texto) || promessa(texto) ||",
        "CAMPANHA_PROMESSA.test(texto) ||", "[camp-promessa] condição recusada: dobre suas vendas"),
    "M105 condição com promessa exigida no e-mail": (CS, "    if (FORBIDDEN.test(all) || promessa(all) || contaminated(all)) return null;\n    if (campanha) {\n      // Condição com promessa nunca é exigida no e-mail (MED-5): sem ela a campanha inteira é recusada (fail-closed).\n      if (promessa(campanha.condicao_comercial) || promessa(campanha.oferta)) return null;\n",
        "    if (FORBIDDEN.test(all) || contaminated(all)) return null;\n    if (campanha) {\n", "[camp-promessa] promessa nunca exigida no e-mail"),
    "M106 data inexistente aceita": (CS, "      if (!realDate(v)) return",
        "      if (!ISO_DATE.test(v)) return", "[camp-datas] 30/02 recusado"),
    "M107 regeneração com a campanha de outro mês": (CS, "      if (record.campanha?.cycle !== record.cycles) return { ok: false, reason: \"campaign_required\" };\n",
        "", "[camp-regen-mes] campanha do mês anterior não serve"),
    "M108 reenvio de bounce reaproveita o token": (CS, "    if (d.pkgKey) { await kv.delete(SENT + d.pkgKey.slice(PKG.length)); await kv.delete(DELIVERY + d.pkgKey.slice(PKG.length)); }",
        "    if (d.pkgKey) { await kv.delete(SENT + d.pkgKey.slice(PKG.length)); }", "[camp-bounce] link novo (nova chave de idempotência)"),
    "M109 regra do mês fora do contrato": (CS, "export const MES_SEM_CAMPANHA = CONTEUDO_PRONTO.mes_sem_campanha;",
        "export const MES_SEM_CAMPANHA = \"O mês fica reservado.\";", "[camp-regra] código lê o contrato"),
    "M110 Termos sem a regra": ("termos/index.html", "<strong>A campanha do mês é necessária para gerar o conteúdo. Se ela não for enviada até a próxima renovação, o mês pago vira crédito: você envia a campanha depois, sem custo adicional, e recebe aquele pacote (créditos usados do mais antigo para o mais novo; no máximo 2 meses em crédito: se um terceiro mês ficar sem campanha, o crédito mais antigo é reembolsado). A qualquer momento você pode pedir ao suporte o reembolso de mês pago sem pacote; no cancelamento, todo mês pago sem pacote é reembolsado. O estorno é processado em até 7 dias úteis. O arrependimento de 7 dias continua valendo.</strong> A assinatura é cancelada",
        " A assinatura é cancelada", "[camp-regra] Termos com destaque (CDC art. 54 §4): termos/index.html"),
    "M111 portão volta a recusar frase promocional comum": (CS, "export const promessa = (t) => PROMESSA_RX.test(normTxt(t));",
        "export const promessa = (t) => PROMESSA_RX.test(normTxt(t)) || /garantid/.test(normTxt(t));", "[camp-promessa-lista] permite: vaga garantida"),
    "M112 portão aceita dinheiro devolvido": (CS, "  \"dinheiro\\\\s+(de\\\\s+volta|devolvido)\",",
        "  \"dinheiro\\\\s+de\\\\s+volta\",", "[camp-promessa-lista] recusa: satisfação total ou seu dinheiro devolvido"),
    "M113 prompt sem a lista de promessas proibidas": (CS, "sem emojis em excesso. \" + PROMESSAS_PROIBIDAS + \" Responda",
        "sem emojis em excesso. Responda", "[camp-promessa-lista] lista de promessas proibidas no prompt"),
    "M114 sem chamada corretiva": (CS, "retryFix = Boolean(parsed) && !corrected && promessa(JSON.stringify(parsed));",
        "retryFix = false;", "[camp-correcao] a segunda chamada leva a instrução corretiva"),
    "M115 palavra genérica ancora": (CS, " && !GENERIC.has(w)); }",
        "); }", "[camp-ancora-vazia] oferta genérica recusada: produto"),
    "M116 operador troca e-mail sem validar": (CS, "    if (newEmail && !/^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$/.test(String(newEmail).trim())) return { ok: false, reason: \"invalid_email\" };\n",
        "", "[camp-operador-email] e-mail inválido recusado"),
    "M117 alerta de novo assinante na renovação sem formulário": (CS, "if (!record.briefing && record.cycles === 1) await ownerAlert(env, \"novo assinante",
        "if (!record.briefing) await ownerAlert(env, \"novo assinante", "[camp-cancelamento] alerta certo na renovação sem formulário"),
    "M118 lembrete que falha sem alerta": (CS, "await ownerAlert(env, \"lembrete do Conteúdo Pronto não saiu\"",
        "if (0) await ownerAlert(env, \"lembrete do Conteúdo Pronto não saiu\"", "[camp-cancelamento] falha de lembrete alertada uma vez"),
    "M119 formulário grava campanha em assinatura cancelada": (CS, "  if (fresh.status !== \"active\") return page(\"Assinatura inativa\"",
        "  if (false) return page(\"Assinatura inativa\"", "[camp-cancelamento] cancelamento durante o formulário vence"),
    "M120 lembretes não param no cancelamento": (CS, "      if (!rec || rec.status !== \"active\" || !needsForm(rec) || rec.cycles !== w.cycle) {",
        "      if (!rec || !needsForm(rec) || rec.cycles !== w.cycle) {", "[camp-cancelamento] nenhum lembrete depois do cancelamento"),
    "M121 envio do formulário não encerra os lembretes": (CS, "  await clearFormWait(kv, found.key);\n",
        "", "[camp-cancelamento] envio do formulário encerra os lembretes"),
    "M122 reenvio de bounce de ciclo antigo": (CS, "    if (Number(dead[key].cycle) !== latest.cycles) return { ok: false, reason: \"cycle_superseded\" };\n",
        "", "[camp-operador-email] ciclo antigo não é reenviado"),
    "M123 posts sem o portão de promessa": (CS, " || promessa(tema + \" \" + legenda + \" \" + cta)) return null;",
        ") return null;", "[camp-promessa-lista] post com promessa recusado"),
    "M124 renovação perde o mês sem campanha": (CS, "  if (current && current.lastTxn !== txn && prev >= 1 && pendingCycles({ ...current, credits: [] }).includes(prev)) {",
        "  if (false) {", "[camp-credito] mês 2 virou crédito"),
    "M125 geração ignora o crédito": (CS, "  const cyc = campaignTarget(record);",
        "  const cyc = Number(record.deliveredCycle || 0) !== Number(record.cycles) ? Number(record.cycles) : null;", "[camp-credito] pacote do mês 2 gerado com o crédito"),
    "M126 sem limite de créditos": (CS, "    overflow = live.slice(0, Math.max(0, live.length - CREDITOS_MAX)).map((c) => c.cycle);",
        "    overflow = [];", "[camp-credito] no máximo 2 créditos"),
    "M127 cancelamento sem reembolso": (CS, "      owed = pendingCycles({ ...latest, refundRequests }).filter((c) => !already.has(c));",
        "      owed = [];", "[camp-reembolso] cancelamento reembolsa todo mês pago sem pacote"),
    "M128 pedido de reembolso sem alerta": (CS, "await ownerAlert(env, \"reembolso do Conteúdo Pronto a processar na Hotmart\"",
        "if (0) await ownerAlert(env, \"reembolso do Conteúdo Pronto a processar na Hotmart\"", "[camp-credito] proprietário avisado do reembolso"),
    "M129 reembolso não tira o mês dos pendentes": (CS, "const refundedCycles = (rec) => new Set((rec?.refundRequests || []).map((r) => Number(r.cycle)));",
        "const refundedCycles = (rec) => new Set();", "[camp-reembolso] mês reembolsado sai dos pendentes"),
    "M130 status sem os créditos": (CS, "      credits: Object.entries(creditIdx)",
        "      _c: Object.entries(creditIdx)", "[camp-credito] crédito visível no status"),
    "M131 estorno de um mês sempre encerra a assinatura": (CS, "const ends = event === \"SUBSCRIPTION_CANCELLATION\" || (Boolean(subStatus) && SUB_ENDED_RX.test(subStatus));",
        "const ends = true;", "[camp-estorno] estorno do mês pedido mantém a assinatura ativa"),
    "M132 mês estornado sem registro fica pendente": (CS, "      else refundRequests.push({ cycle: txnCycle, reason: event.toLowerCase(), at, status: \"processed\", processedAt: at, processedBy: \"webhook:\" + event });\n",
        "", "[camp-estorno] mês estornado sai dos pendentes"),
    "M133 estorno ambíguo sem alerta de confirmação": (CS, "if (!ends && !subStatus && !matched) await ownerAlert(",
        "if (0) await ownerAlert(", "[camp-estorno] sem status: proprietário confirma"),
    "M134 reembolso atrasado sem alerta": (CS, "  await ownerAlert(env, \"reembolso do Conteúdo Pronto atrasado\"",
        "  if (0) await ownerAlert(env, \"reembolso do Conteúdo Pronto atrasado\"", "[camp-reembolso-prazo] alerta de atraso uma vez"),
    "M135 pedido parado não vira overdue": (CS, "for (const r of late) { r.status = \"overdue\";",
        "for (const r of late) { r.status = \"requested\";", "[camp-reembolso-prazo] pedido parado vira overdue"),
    "M136 processado sem pedido aberto": (CS, "    if (!open) return out(400, { ok: false, reason: \"no_open_request\" });\n",
        "    if (!open) return out(200, { ok: true, cycle });\n", "[camp-reembolso-prazo] não processa duas vezes"),
    "M137 estorno não chega à lista do proprietário": (CS, "    if (txnCycle !== null) await markRefundProcessed(kv, key, txnCycle, \"webhook:\" + event);\n",
        "", "[camp-estorno] processado na lista do proprietário"),
    "M138 mesma transação sob outro evento dá crédito em dobro": (CS, "cycles: current?.lastTxn === txn ? Number(current.cycles || 1) :",
        "cycles: false ? Number(current.cycles || 1) :", "[camp-estorno] sem crédito em dobro pela mesma transação"),
    "M139 transação sem ciclo (estorno não acha o mês)": (CS, "  record.txnCycles = Object.fromEntries([...Object.entries(current?.txnCycles || {}), [txn, record.cycles]].slice(-36));",
        "  record.txnCycles = {};", "[camp-estorno] pedido do mês vira processado pelo webhook"),
    "M140 status de encerramento ignorado": (CS, "const SUB_ENDED_RX = /^(CANCEL|INACTIVE|EXPIRED|ENDED)/;",
        "const SUB_ENDED_RX = /^$/;", "[camp-estorno] status de encerramento encerra a assinatura"),
    "M141 /reembolso sem o prazo da regra": ("reembolso/index.html", "O estorno é processado em até 7 dias úteis.",
        "O estorno é processado quando possível.", "[camp-reembolso-prazo] regra do Conteúdo Pronto em reembolso/index.html"),
}



def read_text_normalized(path):
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def write_lf(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def stage(d):
    # Cópia da árvore inteira (sem .git/node_modules): o teste (e) varre todas as páginas do repositório.
    shutil.copytree(REPO, d, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", "node_modules", "__pycache__", "*.pyc"))


def run(d):
    env = {**os.environ, "NO_COLOR": "1", "FORCE_COLOR": "0", "NODE_OPTIONS": ""}
    return mc.run_command([NODE, "--test", "--test-reporter=tap", "--test-reporter-destination=stdout",
                           *[t.as_posix() for t in TESTS]], cwd=str(d), timeout=TIMEOUT, env=env)


def _exact(label):
    # Rótulo do mapa causal = trecho literal do `error` do bloco `not ok` (mesma semântica de antes: substring exata).
    return "re:" + re.escape(label)


def to_expected(spec):
    """Mapa causal (p/s/broad) -> formato do classificador compartilhado (primary/secondary/broad_reason)."""
    out = {"primary": [{"test_pattern": t, "assertion_pattern": _exact(label)} for t, label in spec.get("p") or []],
           "secondary": [{"test_pattern": t, "assertion_pattern": None, "justification": why}
                         for t, why in (spec.get("s") or {}).items()],
           "allowlist": []}
    if spec.get("broad"):
        out["broad_reason"] = spec["broad"]
    return out


MIN_JUSTIFICATION = 20  # mais estrito que o classificador (não vazio): justificativa curta demais não é causal


def causality_problems():
    """Mapa causal inválido => o runner não começa (sem justificativa, PRIMARY fora de 1..3, >4 testes sem broad)."""
    ids = [k.split()[0] for k in M]
    probs = [f"{m}: sem mapa causal" for m in ids if m not in CAUSALITY]
    probs += [f"{m}: mapa causal sem mutante" for m in CAUSALITY if m not in ids]
    for m in ids:
        if m in CAUSALITY:
            probs += spec_problems(m, CAUSALITY[m])
    return probs


def spec_problems(m, spec):
    """Problemas de UM mapa causal: justificativas (>= MIN_JUSTIFICATION) e load_mutant_config do classificador."""
    if not isinstance(spec, dict):
        return [f"{m}: mapa causal deve ser dict"]
    probs = []
    if len(str(spec.get("why", "")).strip()) < MIN_JUSTIFICATION:
        probs.append(f"{m}: PRIMARY sem justificativa (why)")
    for test, why in (spec.get("s") or {}).items():
        if len(str(why or "").strip()) < MIN_JUSTIFICATION:
            probs.append(f"{m}: SECONDARY {test!r} sem justificativa causal")
    if spec.get("broad") is not None and len(str(spec["broad"]).strip()) < MIN_JUSTIFICATION:
        probs.append(f"{m}: broad_reason curto demais")
    try:
        mc.load_mutant_config({m: to_expected(spec)})
    except (mc.ConfigError, TypeError, ValueError) as e:
        probs.append(f"{m}: {e}")
    return probs


CONFIG = None  # preenchido em main() por mc.load_mutant_config, depois de causality_problems() vazio


def attempt(name, fname, old, new, expect, total):
    mid = name.split()[0]
    spec = CONFIG[mid]
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        d = Path(tmp)
        stage(d)
        f = d.joinpath(*fname.split("/"))
        text = read_text_normalized(f)
        if text.count(old) != 1:
            res = mc.classify(total, 1, {}, expected=spec, anchor_ok=False, mutant_id=mid)
            return res["verdict"], f"{res['reason']} (trecho ocorre {text.count(old)} vez(es))", False
        write_lf(f, text.replace(old, new, 1))
        r = run(d)
    res = mc.classify_run(total, r, expected=spec, allowlist=spec["allowlist"], anchor_ok=True, mutant_id=mid)
    return res["verdict"], ("" if res["verdict"] == "KILLED" else res["reason"]), True


def causality_md():
    cell = lambda x: str(x).replace("|", "\\|").replace("\n", " ")
    rows = ["# Conteúdo Pronto — causalidade dos mutantes",
            "",
            "Gerado de `scripts/ci/mutants_conteudo_pronto_causality.py` por `python3 -B scripts/ci/mutants_conteudo_pronto.py --causality-md`",
            "(o CI confere que este arquivo está em dia). Regra (Sol, auditoria 128): a asserção esperada vem do raciocínio sobre a",
            "mutação; KILLED exige falha numa asserção PRIMARY e qualquer outra falha em PRIMARY ou em SECONDARY justificada",
            "(`scripts/ci/mutant_classifier.py`, compartilhado); qualquer outra coisa é INCONCLUSIVE. Contraprova: sem a mutação a baseline passa (20/20)",
            "e a asserção primária é exatamente a que a mutação viola.",
            "",
            "| mutant_id | change | primary assertion | justification | counter-proof |",
            "|---|---|---|---|---|"]
    for name, (fname, old, new, expect) in M.items():
        mid = name.split()[0]
        spec = CAUSALITY[mid]
        prim = "; ".join(f"`{t if t.startswith('(') else 'fluxo completo'}` ⟶ `{label}`" for t, label in spec["p"])
        just = spec["why"]
        if spec.get("s"):
            just += " — SECONDARY: " + "; ".join(f"`{t}`: {w}" for t, w in spec["s"].items())
        if spec.get("broad"):
            just += f" — broad_reason: {spec['broad']}"
        # Sem citar o trecho mutado literalmente: o texto mutado da oferta não pode entrar numa página do repositório
        # (tests/conteudo-pronto-roteiros.test.mjs (e) varre todo .md que descreve o produto).
        counter = (f"sem a mutação a asserção `{spec['p'][0][1]}` passa (baseline 20/20); aplicando a troca \"{name[len(mid) + 1:]}\" "
                   f"em `{fname}` (trecho exato em `M[\"{name}\"]`), ela falha")
        rows.append(f"| {mid} | {cell(name[len(mid) + 1:])} | {cell(prim)} | {cell(just)} | {cell(counter)} |")
    return "\n".join(rows) + "\n"


def one(item, total):
    # INCONCLUSIVE (queda, tempo esgotado, contagem incompleta, falha fora da allowlist) é repetido UMA vez;
    # persistindo, fica INCONCLUSIVE e o job falha.
    name, (fname, old, new, expect) = item
    why = ""
    for n in (1, 2):
        try:
            verdict, why, retriable = attempt(name, fname, old, new, expect, total)
        except (OSError, subprocess.SubprocessError, UnicodeError) as e:
            verdict, why, retriable = "INCONCLUSIVE", f"erro de infraestrutura: {type(e).__name__}: {e}", True
        if verdict != "INCONCLUSIVE" or not retriable:
            break
        why = f"{why} (tentativa {n})"
    return name, verdict, why, expect


def main():
    if "--causality-md" in sys.argv[1:]:
        sys.stdout.write(causality_md())
        return 0
    global CONFIG
    probs = causality_problems()
    if probs:
        for pr in probs:
            print(f"MUTANT CAUSALITY INVALID {pr}")
        print("MUTANT RUNNER REFUSED (mapa causal inválido: corrija a justificativa; não amplie a allowlist)")
        return 4
    CONFIG = mc.load_mutant_config({k.split()[0]: to_expected(CAUSALITY[k.split()[0]]) for k in M})
    if not NODE:
        print("MUTANT BASELINE INCONCLUSIVE (node ausente no PATH)")
        return 3
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            stage(Path(tmp))
            r = run(Path(tmp))
    except (OSError, subprocess.SubprocessError) as e:
        print(f"MUTANT BASELINE INCONCLUSIVE ({type(e).__name__}: {e})")
        return 3
    parsed = mc.parse_tap(r.get("stdout", ""), stderr=r.get("stderr", ""))
    total = parsed["summary"].get("tests")
    b = mc.validate_baseline(total if isinstance(total, int) else -1, r.get("return_code"), parsed["summary"],
                             parsed["failures"], timed_out=r.get("timed_out", False), signal=r.get("signal"))
    if total != BASELINE_TESTS or not b["ok"]:
        print((r.get("stdout", "") + r.get("stderr", ""))[-3000:])
        print(f"MUTANT BASELINE FAILED (suíte sem mutação não passa ou contagem != {BASELINE_TESTS}) rc={r.get('return_code')} motivo={b['reason']}")
        return 2
    print(f"MUTANT BASELINE PASS tests={total} node={subprocess.run([NODE, '--version'], capture_output=True, text=True).stdout.strip()} os={os.name}", flush=True)
    counts = {"KILLED": 0, "SURVIVED": 0, "INCONCLUSIVE": 0}
    results = []
    with ThreadPoolExecutor(max_workers=max(2, min(8, os.cpu_count() or 2))) as ex:
        for name, verdict, why, expect in ex.map(lambda it: one(it, total), M.items()):
            mid = name.split()[0]
            counts[verdict] += 1
            results.append({"mutant_id": mid, "verdict": verdict})
            extra = f" [{why}]" if why else ""
            print(f"MUTANT {mid} {verdict} — {name[len(mid) + 1:]} (asserção: {expect}){extra}", flush=True)
    print(f"MUTANTS_TOTAL={len(M)} KILLED={counts['KILLED']} SURVIVED={counts['SURVIVED']} INCONCLUSIVE={counts['INCONCLUSIVE']}")
    code, _ = mc.aggregate(results, baseline_valid=True)  # 0 todos KILLED; 1 sobrevivente; 3 inconclusivo (3 > 1)
    return code


if __name__ == "__main__":
    sys.exit(main())
