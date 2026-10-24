#!/usr/bin/env python3
"""Mutantes do Conteúdo Pronto (roteiros multicanal, schema versionado; AVAL Sol #898).

Cada mutante altera UMA CÓPIA temporária da árvore (oferta, contrato, gerador, páginas-fonte ou geradas), roda
tests/conteudo-pronto-roteiros.test.mjs e tests/content-service.test.mjs contra a cópia e classifica o resultado
com o classificador estrito scripts/ci/mutant_tap.py (auditoria Sol #898; meta-testes em scripts/ci/test_mutant_tap.py):
  KILLED       rc == 1, resumo TAP completo e coerente com a baseline, toda falha em teste da allowlist do mutante
               (ALLOW) e o rótulo esperado DENTRO do campo `error` de um bloco `not ok`;
  SURVIVED     rc == 0 e resumo TAP completo igual à baseline;
  INCONCLUSIVE qualquer outra coisa (queda, erro de sintaxe/módulo, tempo esgotado, contagem incompleta, falha fora
               da allowlist, rótulo fora do bloco `not ok`, trecho não encontrado). Repetido uma vez; persistindo, o
               job falha.
Texto lido em UTF-8 com CRLF normalizado para LF; arquivo mutado gravado em UTF-8/LF; reporter TAP explícito.
Saída: `MUTANT <id> KILLED|SURVIVED|INCONCLUSIVE`. Exit 0 só se todos KILLED; 1 sobrevivente; 3 inconclusivo;
2 baseline falhou. Uso: python3 scripts/ci/mutants_conteudo_pronto.py [raiz-do-repo]
"""
import os, re, shutil, subprocess, sys, tempfile
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mutant_tap  # noqa: E402  (classificador estrito compartilhável; meta-testes em scripts/ci/test_mutant_tap.py)
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
TESTS = [Path("tests", "conteudo-pronto-roteiros.test.mjs"), Path("tests", "content-service.test.mjs")]
J = "data/politica-unica.json"
CS = "worker/content-service.mjs"
PG = "conteudo-pronto/index.html"
NODE = shutil.which("node")
TIMEOUT = 600

# id -> (arquivo relativo com "/", trecho original (ocorre 1 vez após normalizar EOL), substituto, rótulo da asserção esperada)
M = {
    "M01 oferta volta a WhatsApp (JSON)": (J, "4 roteiros multicanal de venda e acompanhamento — cada um com versão curta e versão de e-mail — e um calendário",
        "4 mensagens de venda para WhatsApp e um calendário", "características essenciais = texto canônico"),
    "M02 hero promete WhatsApp": (PG, "para os canais que seus clientes autorizaram.",
        "para WhatsApp.", "conteudo-pronto/index.html"),
    "M03 item da página volta a WhatsApp": (PG, "<li>4 roteiros multicanal de venda e acompanhamento, cada um com versão curta e versão de e-mail</li>",
        "<li>4 mensagens de venda e acompanhamento para WhatsApp</li>", "conteudo-pronto/index.html"),
    "M04 JSON-LD diverge do texto canônico": (PG, "\"description\": \"Todo mês: 12 posts",
        "\"description\": \"Todo mês, 12 posts", "JSON-LD = texto canônico"),
    "M05 data-content-schema removido da página": (PG, " data-content-schema=\"2\"",
        "", "página e gerador na mesma versão de schema"),
    "M06 versão sobe só no JSON": (J, "\"content_schema_version\": 2",
        "\"content_schema_version\": 3", "página e gerador na mesma versão de schema"),
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
    "M12 validador de roteiros ignora canal banido": (CS, "    if (FORBIDDEN.test(all) || contaminated(all)) return null;",
        "    if (FORBIDDEN.test(all)) return null;", "termo proibido na curta"),
    "M13 validador aceita roteiro sem versão de e-mail": (CS, "if (assunto.length < 5 || assunto.length > 120 || corpo.length < 200 || corpo.length > 1600) return null;",
        "", "versão de e-mail obrigatória"),
    "M14 pacote com versão de schema fixa 1": (CS, "content_schema_version: CONTENT_SCHEMA_VERSION, cycle",
        "content_schema_version: 1, cycle", "[pkg-version]"),
    "M15 calendário com 3 roteiros": (CS, "[5, 12, 19, 26].forEach",
        "[5, 12, 19].forEach", "[calendario]"),
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
    "M22 suporte volta a WhatsApp": ("worker/support-knowledge.mjs", "4 roteiros multicanal de venda e acompanhamento (cada um",
        "4 mensagens de venda para WhatsApp (cada um", "[suporte]"),
    "M23 catálogo-fonte volta a WhatsApp": ("solucoes/index.html", "4 roteiros multicanal de venda e acompanhamento e calendário",
        "4 mensagens de venda para WhatsApp e calendário", "[catalogo]"),
    "M24 página gerada desatualizada": ("sales-public/conteudo-pronto.html", "<dd>Todo mês: 12 posts com legenda, 4 roteiros multicanal",
        "<dd>Todo mês: 12 posts com legenda, 4 mensagens para WhatsApp e roteiros multicanal", "gerado: conteudo-pronto"),
    "M25 kit de afiliado volta a mensagens": ("kit-afiliado/index.html", "12 posts e 4 roteiros multicanal de venda no tom do negócio, entregues",
        "12 posts e 4 mensagens de venda no tom do negócio, entregues", "kit-afiliado/index.html"),
    "M26 llms.txt gerado volta a mensagens": ("sales-public/llms.txt", "assinatura mensal com 12 posts, 4 roteiros multicanal",
        "assinatura mensal com 12 posts, 4 mensagens de venda", "sales-public/llms.txt"),
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
    "M35 catálogo gerado desatualizado": ("sales-public/solucoes.html", "4 roteiros multicanal de venda e acompanhamento e calendário",
        "4 mensagens de venda e calendário", "gerado: solucoes"),
    "M36 leitura não bloqueia pacote contaminado": (CS, "  if (packageBlocked(pkg)) {\n    const cand = eligible",
        "  if (false) {\n    const cand = eligible", "[legacy-html-leak]"),
    "M37 detector ignora o calendário": (CS, "  return [...posts, ...rots, ...cal]",
        "  return [...posts, ...rots]", "[legacy-detect] calendario.tema"),
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
    "M55 429/5xx/tempo esgotado tratados como permanentes": (CS, "transient: resendFailureIsTransient(r.status), reason",
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
    "M78 409 concorrente tratado como permanente": (CS, "    if (r.status === 409 && data?.name === \"concurrent_idempotent_requests\") return",
        "    if (false) return", "[regen-fail] 409 concurrent_idempotent_requests"),
    "M79 POST não converge delivered interrompido": (CS, "  if (cand.delivery === \"delivered\" && !cand.promotedAt) {\n    await applyRegenDelivered(",
        "  if (false) {\n    await applyRegenDelivered(", "[regen-converge] promovido na retomada"),
}

# Testes que cada mutante pode derrubar (ids do classificador: prefixo "(g1)" ou, sem prefixo, o nome inteiro).
# Levantados executando cada mutante e revisados um a um: todos exercitam o trecho mutado. Falha fora daqui = INCONCLUSIVE.
FLOW = "full automatic flow: purchase -> briefing email -> form -> AI package -> delivery email -> renewal regenerates -> cancel stops"
ALLOW = {
    "M01": ("(a)",),
    "M02": ("(b)",),
    "M03": ("(b)",),
    "M04": ("(b)",),
    "M05": ("(b)",),
    "M06": ("(a)", "(b)",),
    "M07": ("(a)",),
    "M08": ("(a)", "(c)",),
    "M09": ("(c)", "(d)",),
    "M10": ("(c)",),
    "M11": ("(c2)",),
    "M12": ("(c2)", "(f3)",),
    "M13": ("(c2)",),
    "M14": ("(c)",),
    "M15": ("(c)",),
    "M16": ("(d)", "(f2)",),
    "M17": ("(d)", "(f2)",),
    "M18": (FLOW,),
    "M19": ("(d)", "(f2)",),
    "M20": ("(d)",),
    "M21": ("(c)", "(d)",),
    "M22": ("(b)",),
    "M23": ("(b)", "(e)",),
    "M24": ("(b)",),
    "M25": ("(b)", "(e)",),
    "M26": ("(b)", "(e)",),
    "M27": ("(c)",),
    "M28": ("(c)",),
    "M29": ("(d)", "(f2)",),
    "M30": ("(d)",),
    "M31": ("(e)",),
    "M32": ("(e)",),
    "M33": ("(e)",),
    "M34": ("(e)",),
    "M35": ("(b)", "(e)",),
    "M36": ("(f)", "(f2)", "(g1)", "(g6)",),
    "M37": ("(f)",),
    "M38": ("(f)",),
    "M39": ("(f)",),
    "M40": ("(f)", "(f3)", "(g6)",),
    "M41": ("(f)", "(f3)", "(g6)",),
    "M42": ("(a)", "(f)", "(f3)", "(g6)",),
    "M43": ("(f2)", "(g1)", "(g2)", "(g3)", "(g4)", "(g5)", "(g6)",),
    "M44": ("(f2)",),
    "M45": ("(f)",),
    "M46": ("(f)", "(g6)",),
    "M47": ("(f3)",),
    "M48": ("(f)", "(g1)", "(g6)",),
    "M49": ("(f2)", "(g1)", "(g2)", "(g3)", "(g6)",),
    "M50": ("(f3)",),
    "M51": ("(g1)", "(g2)", "(g5)",),
    "M52": ("(f2)", "(g1)", "(g2)", "(g3)", "(g5)",),
    "M53": ("(g1)", "(g3)",),
    "M54": ("(g1)", "(g3)",),
    "M55": ("(g1)", "(g5)",),
    "M56": ("(g2)",),
    "M57": ("(g2)", "(g5)",),
    "M58": ("(g2)",),
    "M59": ("(g3)",),
    "M60": ("(f2)", "(g2)", "(g5)",),
    "M61": ("(f2)",),
    "M62": ("(g3)",),
    "M63": ("(f2)", "(g4)", "(g6)",),
    "M64": ("(f2)", "(g1)", "(g2)", "(g3)", "(g4)", "(g5)",),
    "M65": ("(g5)",),
    "M66": ("(g5)",),
    "M67": ("(g2)",),
    "M68": ("(g2)",),
    "M69": ("(g4)",),
    "M70": ("(g4)",),
    "M71": ("(f2)", "(g7)",),
    "M72": ("(g1)", "(g5)", "(g7)",),
    "M73": ("(g3)",),
    "M74": ("(f2)", "(g1)", "(g2)", "(g3)", "(g4)", "(g6)",),
    "M75": ("(g6)",),
    "M76": ("(g6)",),
    "M77": ("(g6)",),
    "M78": ("(g1)",),
    "M79": ("(g3)",),
    "M80": ("(f2)", "(g2)", "(g3)", "(g4)", "(g6)", "(g7)",),
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
    try:
        p = subprocess.run([NODE, "--test", "--test-reporter=tap", *[t.as_posix() for t in TESTS]], cwd=str(d), env=env,
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired as e:
        out = ((e.stdout or b"") + (e.stderr or b"")).decode("utf-8", errors="replace").replace("\r\n", "\n")
        return None, out
    out = (p.stdout + p.stderr).decode("utf-8", errors="replace").replace("\r\n", "\n")
    return p.returncode, out


def summary(out):
    return mutant_tap.summary(out)


def attempt(name, fname, old, new, expect, total):
    allowed = set(ALLOW.get(name.split()[0], ()))
    if not allowed:
        return "INCONCLUSIVE", "mutante sem allowlist", False
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        d = Path(tmp)
        stage(d)
        f = d.joinpath(*fname.split("/"))
        text = read_text_normalized(f)
        if text.count(old) != 1:
            return "INCONCLUSIVE", f"trecho a mutar ocorre {text.count(old)} vez(es)", False
        write_lf(f, text.replace(old, new, 1))
        rc, out = run(d)
    verdict, why = mutant_tap.classify(rc, out, expect, total, allowed)
    return verdict, why, True


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
    if not NODE:
        print("MUTANT BASELINE INCONCLUSIVE (node ausente no PATH)")
        return 3
    try:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            stage(Path(tmp))
            rc, out = run(Path(tmp))
    except (OSError, subprocess.SubprocessError) as e:
        print(f"MUTANT BASELINE INCONCLUSIVE ({type(e).__name__}: {e})")
        return 3
    s = summary(out)
    if rc != 0 or not s["tests"] or mutant_tap.classify(rc, out, "", s["tests"], {"-"})[0] != "SURVIVED":
        print(out[-3000:])
        print(f"MUTANT BASELINE FAILED (suíte sem mutação não passa) rc={rc} resumo={s}")
        return 2
    total = s["tests"]
    missing = sorted(set(k.split()[0] for k in M) ^ set(ALLOW))
    if missing:
        print(f"MUTANT BASELINE INCONCLUSIVE (mutantes sem allowlist ou allowlist órfã: {missing})")
        return 3
    print(f"MUTANT BASELINE PASS tests={total} node={subprocess.run([NODE, '--version'], capture_output=True, text=True).stdout.strip()} os={os.name}", flush=True)
    counts = {"KILLED": 0, "SURVIVED": 0, "INCONCLUSIVE": 0}
    with ThreadPoolExecutor(max_workers=max(2, min(8, os.cpu_count() or 2))) as ex:
        for name, verdict, why, expect in ex.map(lambda it: one(it, total), M.items()):
            mid = name.split()[0]
            counts[verdict] += 1
            extra = f" [{why}]" if why else ""
            print(f"MUTANT {mid} {verdict} — {name[len(mid) + 1:]} (asserção: {expect}){extra}", flush=True)
    print(f"MUTANTS_TOTAL={len(M)} KILLED={counts['KILLED']} SURVIVED={counts['SURVIVED']} INCONCLUSIVE={counts['INCONCLUSIVE']}")
    return 1 if counts["SURVIVED"] else 3 if counts["INCONCLUSIVE"] else 0


if __name__ == "__main__":
    sys.exit(main())
