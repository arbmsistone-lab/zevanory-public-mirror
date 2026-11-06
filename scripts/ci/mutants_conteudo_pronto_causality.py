"""Mapa causal dos mutantes do Conteúdo Pronto (regra Sol, auditoria 128: asserção esperada por RACIOCÍNIO sobre a
mutação, nunca pela gravação do que falhou).

Cada mutante declara:
  p      PRIMARY: 1 a 3 pares (teste, trecho do `error`) que testam DIRETAMENTE a regra mutada;
  why    por que a asserção primária testa essa regra;
  s      SECONDARY (opcional): {teste: justificativa causal de uma linha} — outra asserção que, pelo fluxo do
         código, depende do trecho mutado;
  broad  obrigatório quando primary + secondary somam mais de 4 testes: por que a mutação é ampla.
KILLED exige falha numa asserção PRIMARY e qualquer outra falha em teste primário ou secundário justificado
(classificador compartilhado scripts/ci/mutant_classifier.py, via to_expected em mutants_conteudo_pronto.py). docs/evidence/conteudo-pronto-mutant-causality.md é gerado deste arquivo
(`python3 -B scripts/ci/mutants_conteudo_pronto.py --causality-md`) e o CI confere que está em dia.

DEC-14 (consenso Claude+GPT-6; DEC-04): dos 178 mutantes, 119 cujo trecho-alvo não existe mais no repositório foram
APOSENTADOS por mudança de escopo e saíram deste mapa; cada um está em docs/ops/dec14-cp-retirement-registry.json (id,
trecho, código removido, motivo e substituto). Os 59 cujo alvo continua no repositório ficam aqui e precisam morrer:
os que dependiam de testes aposentados foram reapontados para testes que continuam ([dec14-*], (d), (f)).
scripts/ci/dec14-inventory.py confere ativos + aposentados = 178 e que nenhum aposentado tem o trecho no repositório.
"""


# Justificativas reutilizadas (cada uma é causal para os testes onde aparece).
SCAN_SOURCE = "(d) varre a fonte do gerador por 'WhatsApp'; a mutação insere o termo no arquivo"

CAUSALITY = {
    "M01": dict(p=[("(a)", "características essenciais = texto canônico")], why="(a) compara a oferta do JSON com o texto canônico literal"),
    "M06": dict(p=[("(a)", "[schema-version]")], why="(a) fixa content_schema_version == 3 no oráculo; a mutação sobe só o JSON para 4 (DEC-14: a checagem da página em (b) só roda com o CP à venda; com a lápide, a prova é o oráculo do contrato)"),
    "M07": dict(p=[("(a)", "contrato mudou: suba content_schema_version")], why="(a) confere a impressão digital do contrato v2; texto da regra mudou sem subir a versão"),
    "M08": dict(p=[("(a)", "contrato mudou: suba content_schema_version")], why="(a) confere a impressão digital do contrato v2",
                s={"(c)": "(c) exige os ids dos objetivos na ordem do contrato; o id foi renomeado"}),
    "M09": dict(p=[("(c)", "prompt sem WhatsApp")], why="(c) proíbe WhatsApp no prompt da IA", s={"(d)": SCAN_SOURCE}),
    "M10": dict(p=[("(c)", "prompt traz objetivo e regra")], why="(c) exige id e regra de cada objetivo no prompt"),
    "M11": dict(p=[("(c2)", "ordem dos objetivos")], why="(c2) envia roteiros fora de ordem e exige rejeição"),
    "M12": dict(p=[("(c2)", "termo proibido na curta"), ("(f3)", "[roteiros-guard]")], why="(c2) e (f3) enviam roteiro com canal banido e exigem rejeição"),
    "M13": dict(p=[("(c2)", "versão de e-mail obrigatória")], why="(c2) envia roteiro sem e-mail e exige rejeição"),
    "M14": dict(p=[("(c)", "[pkg-version]")], why="(c) exige content_schema_version do contrato no pacote gerado"),
    "M15": dict(p=[("(c)", "[calendario]")], why="(c) exige 12 posts + 4 roteiros no calendário",
                s={"[camp-pacote]": "[camp-pacote] exige 16 entradas no calendário da campanha; com 3 roteiros o roteiro 4 some (ou quebra a montagem)",
                   "(d)": "(d) conta um rótulo Roteiro por roteiro no calendário do pacote em texto; com 3 roteiros falta um"}),
    "M16": dict(p=[("(d)", "worker/content-service.mjs sem WhatsApp")], why="(d) proíbe WhatsApp na fonte do gerador (rótulo do calendário)"),
    "M17": dict(p=[("(d)", "e-mail do pacote")], why="(d) proíbe WhatsApp no e-mail do pacote (título)",
                s={"(f)": "(f) confere o pacote v1 limpo em texto sem WhatsApp; o título mutado entra no texto"}),
    "M18": dict(p=[("(d)", "[texto-versao-email]")], why="(d) gera um pacote e conta uma linha 'Versão de e-mail:' por roteiro no pacote em texto (DEC-14: o fluxo completo em KV foi aposentado)"),
    "M21": dict(p=[("(d)", "[form]")], why="(d) proíbe WhatsApp no formulário renderizado",
                s={"(c)": "briefingText usa os rótulos do formulário no prompt; o rótulo mutado leva WhatsApp ao prompt"}),
    "M22": dict(p=[("(b)", "[suporte]")], why="(b) exige o texto do contrato na base de suporte"),
    "M27": dict(p=[("(c)", "campo antigo 'mensagens' não é mais gerado")], why="(c) proíbe o campo mensagens no pacote v2"),
    "M28": dict(p=[("(c)", "objetivo exibido vem do contrato")], why="(c) exige o título do objetivo vindo do contrato"),
    "M29": dict(p=[("(f)", "[legacy-clean]")], why="(f) exige rótulo neutro 'Roteiro' para o tipo antigo do calendário v1 no pacote em texto (DEC-14: antes em (f2), aposentado)"),
    "M30": dict(p=[("(d)", "[aviso]")], why="(d) exige a regra de consentimento no aviso dos roteiros"),
    "M37": dict(p=[("(f)", "[legacy-detect] calendario.tema")], why="(f) contamina calendario.tema e exige bloqueio"),
    "M38": dict(p=[("(f)", "[legacy-detect] posts.hashtags")], why="(f) contamina hashtags e exige bloqueio"),
    "M39": dict(p=[("(f)", "[legacy-detect] mensagens.objetivo")], why="(f) contamina mensagens.objetivo e exige bloqueio"),
    "M40": dict(p=[("(f)", "número banido mascarado"), ("(f3)", "número banido mascarado"), ("(g6)", "número banido mascarado")],
                why="(f), (f3) e (g6) usam o número banido mascarado e exigem bloqueio/rejeição"),
    "M41": dict(p=[("(f)", "número banido completo"), ("(f3)", "número banido completo"), ("(g6)", "número banido completo")],
                why="(f), (f3) e (g6) usam o número banido em dígitos e exigem bloqueio/rejeição"),
    "M42": dict(p=[("(f)", "× wa.me"), ("(f3)", "wa.me"), ("(g6)", "× wa.me")], why="(f), (f3) e (g6) usam wa.me e exigem bloqueio/rejeição",
                s={"(a)": "remover wa.me de termos_proibidos_regex muda o contrato e a impressão digital conferida em (a)"}),
    "M46": dict(p=[("(f)", "[legacy-text-leak]"), ("(g6)", "[v2-text-leak]")], why="(f)/(g6) exigem o pacote em texto bloqueado sem vazamento"),
    "M47": dict(p=[("(f3)", "[posts-guard]")], why="(f3) envia post contaminado e exige rejeição"),
    "M50": dict(p=[("(f3)", "[number-false-positive]")], why="(f3) exige que outro DDD com os mesmos 4 dígitos não seja bloqueado"),
    "M75": dict(p=[("(g6)", "[v2-detect] roteiros.curta")], why="(g6) contamina só a curta de um v2 gravado e exige bloqueio"),
    "M76": dict(p=[("(g6)", "[v2-detect] roteiros.email.assunto")], why="(g6) contamina só o assunto de um v2 gravado e exige bloqueio"),
    "M77": dict(p=[("(g6)", "[v2-detect] roteiros.email.corpo")], why="(g6) contamina só o corpo de um v2 gravado e exige bloqueio"),
    # v3 (Sol AVAL 304): campanha mensal de promoção de vendas.
    "M81": dict(p=[("[camp-recusa]", "[camp-recusa] 6 dias")], why="[camp-recusa] envia período de 6 dias e exige recusa da campanha e do gerador"),
    "M82": dict(p=[("[camp-recusa]", "[camp-recusa] sem objetivo_comercial")], why="[camp-recusa] tira cada campo de texto da campanha e exige recusa"),
    "M83": dict(p=[("[camp-recusa]", "[camp-recusa] promessa de resultado")], why="[camp-recusa] envia 'venda garantida' na condição e exige recusa",
                s={"[camp-promessa]": "[camp-promessa] também exige recusar promessa na condição; a mutação tira o portão inteiro",
                   "[camp-promessa-lista]": "[camp-promessa-lista] também exige recusar as promessas na campanha; a mutação tira o portão inteiro"}),
    "M84": dict(p=[("[camp-ancora]", "[camp-ancora] post sem a oferta")], why="[camp-ancora] valida post que não cita a oferta e exige rejeição",
                s={"[camp-ancora-vazia]": "[camp-ancora-vazia] também valida posts que não citam a oferta (só 'Escovação'); sem a checagem eles passam"}),
    "M85": dict(p=[("[camp-ancora]", "[camp-ancora] post sem fase")], why="[camp-ancora] valida post sem fase e exige rejeição"),
    "M86": dict(p=[("[camp-ancora]", "[camp-ancora] e-mail sem a condição comercial")], why="[camp-ancora] valida roteiro cujo e-mail não traz a condição e exige rejeição"),
    "M87": dict(p=[("[camp-ancora]", "[camp-ancora] fases não cobertas")], why="[camp-ancora] usa IA que põe todos os posts numa só fase e exige nenhum pacote"),
    "M88": dict(p=[("[camp-pacote]", "[camp-pacote] calendário no período e em ordem")], why="[camp-pacote] exige todas as datas do calendário dentro do período informado",
                s={"(c)": "(c) exige dia do calendário <= calendario_dias; com o período esticado o dia passa de 30"}),
    "M94": dict(p=[("(a)", "[campanha] serviço")], why="(a) fixa o serviço do contrato v3 como campanha mensal de promoção de vendas"),
    "M95": dict(p=[("(a)", "[campanha] descricao_hotmart_proposta")], why="(a) exige a campanha mensal de promoção de vendas na descrição Hotmart proposta",
                s={"[camp-textos]": "[camp-textos] também exige a campanha na descrição Hotmart proposta"}),
    "M97": dict(p=[("[camp-textos]", "[camp-textos] chat ainda bloqueia")], why="[camp-textos] exige que o chat continue bloqueando 'promoção' fora do nome do serviço"),
    "M98": dict(p=[("[camp-textos]", "[camp-textos] atendimento ainda bloqueia")], why="[camp-textos] exige que o atendimento continue bloqueando 'promoção' fora do nome do serviço"),
    "M103": dict(p=[("[camp-ancora-vazia]", "[camp-ancora-vazia] 'Escovação' não ancora 'Escova'")], why="[camp-ancora-vazia] exige termo com conteúdo e palavra inteira"),
    "M104": dict(p=[("[camp-promessa]", "[camp-promessa] condição recusada: dobre suas vendas")], why="[camp-promessa] exige recusar promessa na condição comercial",
                s={"[camp-promessa-lista]": "[camp-promessa-lista] também exige a campanha recusando as promessas da lista"}),
    "M105": dict(p=[("[camp-promessa]", "[camp-promessa] promessa nunca exigida no e-mail")], why="[camp-promessa] exige que o validador nunca peça promessa no e-mail"),
    "M106": dict(p=[("[dec14-datas]", "[dec14-datas] 30/02 recusado")], why="[dec14-datas] exige data real (DEC-14: reconstrução pura de [camp-datas], aposentado)",
                s={"[dec14-fuso]": "[dec14-fuso] também exige recusar data inexistente (29/02/2027 e 30/02)"}),
    "M111": dict(p=[("[camp-promessa-lista]", "[camp-promessa-lista] permite: vaga garantida")], why="[camp-promessa-lista] exige que 'vaga garantida' passe"),
    "M112": dict(p=[("[camp-promessa-lista]", "[camp-promessa-lista] recusa: satisfação total ou seu dinheiro devolvido")], why="[camp-promessa-lista] exige recusar 'dinheiro devolvido'"),
    "M113": dict(p=[("[camp-promessa-lista]", "[camp-promessa-lista] lista de promessas proibidas no prompt")], why="[camp-promessa-lista] exige a lista no prompt"),
    "M114": dict(p=[("[camp-correcao]", "[camp-correcao] a segunda chamada leva a instrução corretiva")], why="[camp-correcao] exige a chamada corretiva depois de recusa por promessa"),
    "M115": dict(p=[("[camp-ancora-vazia]", "[camp-ancora-vazia] oferta genérica recusada: produto")], why="[camp-ancora-vazia] exige que palavra genérica não ancore sozinha"),
    "M123": dict(p=[("[camp-promessa-lista]", "[camp-promessa-lista] post com promessa recusado")], why="[camp-promessa-lista] exige o portão de promessa nos posts",
                s={"[camp-correcao]": "[camp-correcao] depende da recusa do post com promessa para disparar a chamada corretiva"}),
    "M141": dict(p=[("[dec14-reembolso-texto]", "[dec14-reembolso-texto] regra do Conteúdo Pronto em reembolso/index.html")], why="[dec14-reembolso-texto] exige a regra única do contrato (com o prazo) em /reembolso (DEC-14: reconstrução pura de [camp-reembolso-prazo], aposentado)"),
    "M172": dict(p=[("[camp-pacote]", "[camp-pacote] período do texto = período da campanha")], why="[camp-pacote] falha se houver: período do texto trocado"),
    "M174": dict(p=[("[dec14-fuso]", "[dec14-fuso] 21h de Brasília ainda é hoje")], why="[dec14-fuso] (reconstrução pura de [camp-fuso]) falha se houver: hoje do formulário volta a UTC (recusa às 21h de Brasília)"),
    "M176": dict(p=[("[dec14-fuso]", "[dec14-fuso] data civil de Brasília")], why="[dec14-fuso] (reconstrução pura de [camp-fuso]) falha se houver: data civil calculada em UTC"),
    "M177": dict(p=[("[dec14-fuso]", "[dec14-fuso] data impossível sem exceção")], why="[dec14-fuso] (reconstrução pura de [camp-fuso]) falha se houver: data impossível sem guarda de Invalid Date (RangeError)"),
}
