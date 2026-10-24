# Causalidade dos mutantes do suporte@ (#900)

Gerado de `scripts/ci/mutants_support_email_allow.json` (suíte unitária) e `scripts/ci/mutants_support_email_pg_allow.json` (PostgreSQL 16 real).

As listas causais foram escritas por **raciocínio sobre cada mutação**: qual regra o mutante quebra e qual teste a verifica diretamente. Elas **não** foram derivadas de falhas observadas.

## Regras do classificador (`scripts/ci/mutants_support_email.py`)

- **KILLED** exige todas as condições abaixo:
  - saída normal do processo (código 1);
  - contagem TAP completa;
  - todas as falhas são asserções (`ERR_ASSERTION`);
  - **ao menos uma** falha em teste **primário**;
  - nenhuma falha fora de primário ∪ secundário justificado.
- **SURVIVED**: código 0 com contagem completa.
- **INCONCLUSIVE**: todo o resto, ou seja, queda, timeout, erro de sintaxe ou módulo, contagem incompleta, falha que não é asserção, falha só em secundário e falha fora da lista. O caso é repetido 1 vez; se persistir, o job falha.
- A lista é validada **antes** de rodar qualquer mutante. O runner recusa a lista (exit 2) quando há:
  - mutante sem entrada ou entrada órfã;
  - teste inexistente;
  - entrada sem justificativa;
  - primário fora de 1–3;
  - mais de 4 testes sem `broad_reason`.
- Meta-testes do classificador: `tests/test_mutants_support_email_classifier.py`, com casos sintéticos e com node real.

A coluna **contraprova** dá, para cada mutante, um teste fora da sua lista. Se só esse teste falhasse, o veredito seria INCONCLUSIVE (meta-testes `test_unrelated_failure_is_inconclusive`, `test_secondary_only_failure_is_inconclusive` e `test_real_non_causal_failure`).

## Suíte unitária (104 mutantes)

| mutant_id | mudança introduzida | asserção primária (teste) | justificativa causal | contraprova |
|---|---|---|---|---|
| A1 | alerta de mortas nunca é enviado | **U12** — afirma um alerta 'não entregues' | U27 (secundário): afirma alerta de morte exatamente uma vez após ack_dead | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| A2 | limite de alerta removido | **U12** — afirma no máximo 1 alerta por tipo a cada 6 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| A3 | vaga de alerta não é liberada após falha | **U12** — afirma alerta enviado depois de uma falha de envio | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| A4 | linhas mortas não são marcadas como alertadas | **U12** — afirma que o mesmo morto não gera novo alerta após 7 h | U27 (secundário): afirma alerta de morte exatamente uma vez após ack_dead | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| A5 | ignora o limiar de quantidade da fila | **U12** — afirma alerta com 5 pendentes recentes | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| A6 | ignora o limiar de idade da fila | **U12** — afirma alerta com 1 pendente antigo (>= 2 h) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B1 | lease ignora tentativas/janela (SQL) | **U15** — afirma orçamento no lease | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B2 | orçamento em código ignora tentativas | **U10** — afirma zero chamada com attempts > MAX e withinBudget false | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B3 | orçamento em código ignora a janela | **U10** — afirma zero chamada com idade >= 23 h e withinBudget false | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B4 | remove o reap | **U10** — afirma forward_dead pelo cron sem tentativa | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B5 | janela além da Idempotency-Key (48 h) | **U10** — afirma nenhuma repetição após 23 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| B6 | due ignora o orçamento (SQL) | **U16** — afirma orçamento no comando due | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| C1 | motivos colapsados em um só | **U24** — afirma last_reason por status<br>**U33** — afirma last_reason por classe | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| C2 | não alerta chave recusada | **U24** — afirma alerta 'chave de leitura do Resend recusada' em 401/403 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| C3 | 401 não é permissão de chave | **U24** — afirma content_http_401_key_permission | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| C4 | não grava last_reason | **U24** — afirma row.last_reason<br>**U33** — afirma last_reason de 404/400/422 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| C5 | classes de rede perdidas | **U33** — afirma content_timeout/network_dns/network_reset | U24 (secundário): afirma content_network para fetch lançado | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D1 | lease sem condição de estado pendente (SQL) | **U15** — afirma 'state in (forward_pending, ack_pending)' no lease | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D2 | falha da confirmação conclui a linha | **U07** — afirma ack_pending após falha e exatamente uma confirmação na recuperação | U27 (secundário): espera que a falha da confirmação conte para ack_dead; concluir vira done<br>U28 (secundário): espera ack_pending após a falha de envio da confirmação | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D3 | falha de envio do ENCAMINHAMENTO vira morte imediata (só o passo de encaminhamento) | **U06** — afirma forward_pending com recuo após uma falha e encaminhamento na retentativa<br>**U08** — afirma forward_dead só após MAX_SEND_FAILURES tentativas de encaminhamento | U12 (secundário): o alerta de fila atrasada depende de pendências mantidas por falhas transitórias de encaminhamento<br>U25 (secundário): a linha de contagem do dreno espera done=1 após uma falha transitória de encaminhamento<br>U26 (secundário): o dreno autenticado espera concluir um encaminhamento que falhou uma vez<br>U27 (secundário): o cenário 9+1 exige 9 falhas de encaminhamento retentadas antes do teto<br>U32 (secundário): o caso do provedor automático exige retentar o encaminhamento após 2 falhas<br>U34 (secundário): o orçamento separado exige 9 falhas de encaminhamento retentadas<br>U36 (secundário): a fila vencida do cron é construída com falhas de encaminhamento retentadas<br>*broad_reason:* retentar uma falha transitória de encaminhamento é pré-condição desses cenários; a morte prematura remove a pré-condição em cada teste listado (cada um com justificativa) | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D4 | lease ignora o recuo (SQL) | **U15** — afirma 'next_attempt_at <= now()' no lease | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D5 | lease ignora a exclusividade (SQL) | **U15** — afirma '(lease_until is null or lease_until < now())' no lease | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D6 | nunca marca *_dead | **U10** — afirma forward_dead para orçamento/janela estourados<br>**U33** — afirma forward_dead para 400/422 e 404 tardio | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D7 | remove a Idempotency-Key do encaminhamento | **U06** — afirma idem support-fwd/<id> em todas as tentativas<br>**U02** — afirma idem support-fwd/em-1 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D8 | remove a Idempotency-Key da confirmação | **U07** — afirma idem support-ack/<id> em todas as tentativas<br>**U02** — afirma idem support-ack/em-1 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D9 | webhook responde 503 quando o passo falha | **U06** — afirma 200 com state forward_pending (registro durável) | U24 (secundário): afirma 200 'registro durável aceito' quando a leitura falha<br>U05 (secundário): a redelivery com a linha concluída recebe estado not_due; o mutante a transforma em 503 | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| D10 | remove o despacho do dreno no cron (compat) | **U23** — afirma await dispatchSupportDrain no ramo horário | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F1 | remove o Reply-To do encaminhamento | **U02** — afirma reply_to = [cliente]<br>**U30** — afirma reply_to esperado em cada caso de chamado | U37 (secundário): o teste de corpo não confiável também afirma reply_to = [cliente] | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F2 | remove o prefixo do assunto | **U02** — afirma assunto '[ZEVANORY suporte] …' | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F3 | cai para destino fixo quando não configurado | **U03** — afirma 503 sem destino configurado | U25 (secundário): o dreno sem destino precisa registrar skipped unconfigured; o destino fixo o torna configurado | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F4 | aceita destino no próprio domínio | **U03** — afirma 503 para destino suporte@ | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F5 | remove o alias contato@ | **U03** — afirma que contato@ é tratado (200) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F6 | registra o texto no log do caminho sem confirmação | **U13** — afirma log sem conteúdo nos casos de auto-resposta | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| F7 | usa a chave de envio para ler recebidos | **U24** — afirma GET com Bearer da chave de leitura<br>**U02** — afirma Bearer re_full_receiving na leitura | U09 (secundário): afirma que a chave de leitura vinda do KV é a usada no GET | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G1a | remetente pelo cabeçalho do corpo | **U31** — afirma confirmação ao cliente quando só o cabeçalho diz WhatsApp | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G1b | aceita vários endereços no remetente | **U31** — afirma providerAddress vazio para listas | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G2a | Reply-To com dois destinatários aceita o primeiro | **U30** — afirma sender no caso de dois destinatários | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G2b | Reply-To com CRLF/lista aceito | **U30** — afirma sender nos casos CRLF/LF/lista | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G2c | Reply-To lido do cabeçalho | **U30** — afirma sender quando o ticket só está no cabeçalho | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G3 | marca skipped com encaminhamento falhando | **U32** — afirma ack_status null enquanto o encaminhamento falha | U36 (secundário): a fila vencida do cron usa remetente WhatsApp com encaminhamento falhando; o mutante conclui a linha | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G5a | 404 permanente de imediato | **U33** — afirma 404 seguido de sucesso | U24 (secundário): afirma forward_pending para 404 | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G5b | 404 transitório para sempre | **U33** — afirma 404 tardio => forward_dead permanente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G5c | 400/422 transitórios | **U33** — afirma forward_dead para 400/422 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G5d | 429/5xx permanentes | **U33** — afirma forward_pending para 429/5xx | U24 (secundário): afirma forward_pending para 429/5xx | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G6 | orçamento compartilhado no SQL de retry | **U18** — afirma incremento por tipo no SQL de retry | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G6b | código soma os dois contadores | **U34** — afirma envio com orçamento próprio após 5 falhas de leitura | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G7 | chamada à supressão global do Resend | **U35** — afirma só /emails e /emails/receiving/* | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G8a | email_id no log | **U36** — afirma ausência do id no log do cron | U24 (secundário): afirma log sem 'em-1' nos motivos de leitura | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G8b | overdue nunca marcado | **U36** — afirma overdue true com fila >= 2 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G8c | cron continua verde com fila vencida (compat) | **U23** — afirma o throw support_backlog_overdue depois das tarefas | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| G9 | Reply-To tirado do corpo | **U37** — afirma reply_to = cliente apesar de 'Reply-To:' no corpo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| H1 | hash simples em vez de HMAC | **U04** — afirma sender_ref = HMAC com LEAD_PRIVACY_SECRET | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| H2 | aceita sem segredo de privacidade | **U04** — afirma 503 sem LEAD_PRIVACY_SECRET | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| I1 | 409 idempotente tratado como falha | **U11** — afirma um único POST de encaminhamento e forward_id idempotent: | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K1 | dreno não registra a execução | **U25** — afirma exatamente uma linha 'drain' por execução | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K2 | assinatura do dreno não conferida | **U26** — afirma 401 para segredo/caminho/método adulterados | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K4 | dispatch nunca usa SELF | **U26** — afirma dispatch via SELF com nonces distintos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K5 | classe de erro do dreno perdida | **U25** — afirma error too_many_subrequests | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K6 | rota do dreno removida do Worker | **U23** — afirma a rota /api/internal/support/outbox/drain | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| K7 | dreno despachado depois do preflight | **U23** — afirma o despacho antes de runSalesPreflight | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| L1 | ignora Auto-Submitted | **U13** — afirma sem confirmação para Auto-Submitted: auto-replied | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| L2 | ignora o veredito de automação | **U13** — afirma sem confirmação para cada caso automático<br>**U29** — afirma skipped_automated_provider para o WhatsApp | U31 (secundário): afirma supressão quando o metadado diz WhatsApp<br>U32 (secundário): afirma 0 confirmação para o provedor automático | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| L4 | confirma remetente no-reply/mailer-daemon | **U13** — afirma sem confirmação para no-reply e MAILER-DAEMON | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| L5 | confirma remetente do próprio domínio | **U13** — afirma sem confirmação para contato@zevanory.api.br | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| L6 | confirmação sem Auto-Submitted | **U02** — afirma header Auto-Submitted: auto-replied na confirmação | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N1 | aceita minuto futuro | **U26** — afirma 401 para minuto futuro | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N2 | recusa o minuto anterior | **U26** — afirma 200 para o minuto anterior | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N3 | aceita replay | **U26** — afirma 409 no replay e no segundo consumidor | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N4 | aceita corpo não vazio | **U26** — afirma 400 para corpo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N5 | muda a string canônica | **U26** — afirma drainCanonical = v1\nPOST\n… | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N6 | formato de nonce frouxo | **U26** — afirma 401 para nonce maiúsculo/curto | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| N7 | cabeçalho interno autentica | **U26** — afirma 401 com x-zevanory-internal | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| O1 | encaminhamento sai do endereço do dono | **U02** — afirma from = suporte@ no encaminhamento | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| O2 | Reply-To da confirmação aponta para o dono | **U02** — afirma reply_to = [suporte@] e ausência do dono na confirmação | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| O3 | confirmação sai do endereço do dono | **U02** — afirma from = suporte@ na confirmação | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| P1 | trata prova-sandbox@ neste fluxo | **U22** — afirma null para prova-sandbox@ | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| P2 | engole eventos de entrega | **U22** — afirma null para email.delivered | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| P3 | consome o corpo original | **U22** — afirma bodyUsed false para o handler legado | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| Q1 | cota por remetente não aplicada | **U14** — afirma 'on conflict (bucket, day) do nothing' na vaga do remetente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| Q2 | teto diário não aplicado | **U14** — afirma 'n < $3' no teto global | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| Q3 | vaga global sem vaga do remetente | **U14** — afirma que a vaga global depende de s | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| Q4 | sem trava da linha | **U14** — afirma 'for update' na linha | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| R1 | aceita sem chave de leitura | **U09** — afirma 503 e nenhuma linha/chamada sem chave de leitura | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| S1 | não confere a assinatura Svix | **U01** — afirma 401 para assinatura inválida/ausente | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| S2 | ignora a tolerância de 5 min do carimbo | **U01** — afirma 401 para carimbo vencido (301 s) | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| S3 | aceita qualquer valor v1 | **U01** — afirma 401 para assinatura de outro segredo/corpo alterado | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| S4 | aceita segredo sem prefixo whsec_ | **U01** — afirma 401 para segredo fora do formato Svix | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| U1 | contadores zerados na transição (SQL) | **U19** — afirma ausência de read_failures = 0/send_failures = 0 no comando de transição | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| U2 | contadores zerados na cadeia em código | **U19** — afirma que a cadeia stepAck não zera contadores | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| W1 | Reply-To do ticket ignorado | **U30** — afirma reply_to = ticket no caso válido | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| W2 | limites de dígitos removidos | **U30** — afirma sender para 4 e 21 dígitos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| W3 | Reply-To do ticket para qualquer remetente | **U30** — afirma reply_to = cliente quando o remetente não é o WhatsApp | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| WS1 | WhatsApp não suprimido | **U29** — afirma 0 confirmação e skipped_automated_provider | U31 (secundário): afirma supressão quando o metadado diz WhatsApp<br>U32 (secundário): afirma 0 confirmação para o provedor automático | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| WS2 | supressão por sufixo (larga demais) | **U29** — afirma que xsupport@support.whatsapp.com não é suprimido | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X1 | mantém o conteúdo de <script> | **U20** — afirma ausência de 'alert(' na saída | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X2 | permite qualquer tag | **U20** — afirma que só tags permitidas sobrevivem | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X3 | permite href javascript: | **U20** — afirma ausência de javascript: | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X4 | não itera a remoção aninhada | **U20** — afirma remoção de <scr<script>… | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X5 | remove o teto de saída do HTML | **U20** — afirma html omitido acima de MAX_HTML_OUT | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X6 | aceita extensão executável | **U21** — afirma recusa de .exe/.js/.docm | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X7 | aceita content-type executável | **U21** — afirma recusa de x-msdownload | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X8 | aceita tamanho desconhecido/zero | **U21** — afirma recusa de tamanho ausente/0 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X9 | remove o teto de quantidade | **U21** — afirma no máximo 5 anexos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| X10 | remove o teto total de bytes | **U21** — afirma 2 de 3 anexos de 9 MB | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |

Testes da suíte unitária:
- U01: assinatura inválida, ausente, vencida, sem segredo ou fora do formato é recusada (401) sem efeito
- U02: suporte@: encaminhado uma vez de suporte@ (Reply-To cliente, prefixo) e confirmado uma vez; dono nunca exposto; logs limpos
- U03: contato@ e destino via KV; destino ausente ou no próprio domínio => 503; nada fixo no código
- U04: remetente pseudonimizado com HMAC (LEAD_PRIVACY_SECRET); sem segredo => 503, nunca hash simples
- U05: redelivery do mesmo email_id depois de concluído: duplicado, nenhum envio novo
- U06: falha no encaminhamento: registro durável, recuo, cron encaminha exatamente uma vez e confirma uma vez
- U07: falha na confirmação depois do encaminhamento: fica ack_pending e a recuperação envia exatamente uma confirmação
- U08: lease impede processamento concorrente; tentativas esgotadas => forward_dead e o cron para
- U09: sem a chave de leitura do Resend: 503 ANTES de aceitar (nenhuma linha, nenhuma chamada)
- U10: orçamento: 10+ tentativas ou fora da janela de 23 h nunca chegam a um efeito externo (SQL e código)
- U11: 409 invalid_idempotent_request no encaminhamento = já encaminhado antes: não reenvia
- U12: alertas ao dono: linhas mortas e fila acumulada/antiga, sem conteúdo, 1 por tipo a cada 6 h, liberado se o envio falhar
- U13: confirmação: nunca para auto-resposta/bounce/lista/no-reply/próprio domínio/dono; 1 por remetente/dia; teto diário; desligável
- U14: cota reservada atomicamente: um único comando trava a linha, reserva remetente e global e muda o estado
- U15: SQL lease: só linha pendente, vencida, sem lease ativo e dentro do orçamento; marca lease e conta tentativa
- U16: SQL due e reap: dreno só pega linha elegível; reap mata quem estourou orçamento/janela
- U17: SQL de registro e conclusão: insert idempotente e transições só a partir do estado certo
- U18: SQL retry: contadores de leitura e de envio são distintos (cada falha incrementa só o seu tipo)
- U19: transição para a confirmação preserva os contadores globais (SQL e cadeia em código)
- U20: HTML higienizado por lista de permissão e com teto de tamanho
- U21: anexos: executáveis, tamanho desconhecido/excessivo e excesso de quantidade são recusados
- U22: prova-sandbox@, outros destinatários e eventos de entrega seguem para o handler legado (null), sem efeito
- U23: Worker: webhook interceptado antes do legado/WhatsApp, outbox drenado no cron horário; doc exige responder como suporte@
- U24: leitura do recebido: GET /emails/receiving/{email_id} com a chave de leitura; motivos sem dado pessoal por status
- U25: dreno: uma linha só de contagens por execução, inclusive sem configuração e com exceção
- U26: dreno interno: HMAC de método+caminho+minuto+nonce; minuto atual/anterior; nonce consumido (replay 409); cabeçalho interno não autentica
- U27: orçamento global por mensagem: falhas de envio do encaminhamento contam na confirmação; esgotar => ack_dead sem desfazer o encaminhamento
- U28: orçamento global de LEITURA: 9 falhas no encaminhamento + 1 na releitura da confirmação => ack_dead, encaminhamento preservado
- U29: supressão da confirmação: support@support.whatsapp.com (qualquer caixa) nunca recebe; encaminhamento obrigatório
- U30: Reply-To do chamado WhatsApp: só UM endereço do metadado casando ^[0-9]{5,20}@support.whatsapp.com$ passa
- U31: remetente decidido pelo metadado do provedor (from da API), não por cabeçalho; normalizado; vários endereços => inválido
- U32: provedor automático: encaminhamento falhando NUNCA marca skipped/done; webhook duplicado + 2 drenos => 1 encaminhamento, 0 confirmação
- U33: leitura do conteúdo: 404 transitório por tempo limitado (depois sucesso), 400/422 permanentes, 429/timeout/DNS/reset/5xx transitórios
- U34: orçamentos separados: falhas de leitura não consomem tentativas de envio
- U35: nenhuma chamada à supressão global do Resend: só /emails e /emails/receiving/*
- U36: logs do cron: só contagens e categorias fechadas (sem email_id, remetente, assunto, Reply-To ou corpo); fila vencida => overdue
- U37: corpo não confiável: instruções e endereços no corpo não mudam destinatário, supressão, estado nem fluxo

## PostgreSQL 16 real (8 mutantes de SQL)

Mutantes de SQL que só o banco real prova causalmente, porque a suíte unitária usa um banco falso. Por exemplo, PU1 corresponde às asserções de preservação de contadores de O16/O18, e PG6 ao teste que distingue os dois contadores (O14).

| mutant_id | mudança introduzida | asserção primária (teste) | justificativa causal | contraprova |
|---|---|---|---|---|
| PA1 | limite atômico do alerta removido | **O11** — afirma um único alerta com 3 drenos concorrentes | O16 (secundário): afirma alerta de morte exatamente uma vez<br>O18 (secundário): afirma alerta de morte exatamente uma vez<br>O10 (secundário): afirma no máximo 1 alerta operacional em 3 rodadas de drenos concorrentes | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PG6 | falha de leitura também incrementa send_failures | **O14** — afirma read_failures 3 e send_failures 0 depois de 3 falhas de leitura | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PL1 | lease sem exclusividade | **O3** — afirma 1 lease, 1 encaminhamento e 1 confirmação com 8 consumidores<br>**O2** — afirma 1 encaminhamento por e-mail com 2 drenos | O9 (secundário): afirma not_due com lease ativo<br>O8 (secundário): roda 2 drenos simultâneos e afirma 1 encaminhamento para a linha de 22h59<br>O12 (secundário): webhook duplicado + 2 drenos simultâneos e afirma 1 encaminhamento<br>*broad_reason:* o lease é a única guarda de concorrência; todo teste que roda consumidores simultâneos e afirma exatamente-uma-vez o observa | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PN1 | nonce sem ON CONFLICT (replay vira erro de PK em vez de 409) | **O17** — afirma [200, 409, 409, 409, 409] e 409 no replay | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PQ1 | vaga do remetente reservada mais de uma vez | **O4** — afirma 1 confirmação para 6 e-mails do mesmo remetente | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PQ2 | teto global ignorado | **O5** — afirma exatamente 30 confirmações para 36 remetentes | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PR1 | reap removido | **O7** — afirma *_dead pelo dreno para linhas com contadores/leases estourados (ramo de orçamento)<br>**O8** — afirma forward_dead para a linha de 23h01 (ramo de janela)<br>**O9** — afirma forward_dead depois que o lease vence | O10 (secundário): afirma *_dead para linhas fora do orçamento após drenos concorrentes<br>O11 (secundário): o alerta de mortas só existe se as linhas virarem dead pelo reap<br>*broad_reason:* o reap é o único caminho de linha pendente fora do orçamento para *_dead; todo teste que afirma essa transição terminal o observa | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |
| PU1 | zera read_failures/send_failures na transição para ack_pending | **O16** — afirma send_failures = 10 e ack_dead após 9+1<br>**O18** — afirma read_failures 9 preservado e ack_dead na 10ª | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE, não KILLED; falha só em secundário ⇒ INCONCLUSIVE |

Testes da suíte PostgreSQL:
- O1: O1 esquema aplicado exatamente como o Worker aplica (idempotente), com estados e chaves esperados
- O2: O2 dois consumidores concorrentes nas mesmas linhas: cada e-mail encaminhado e confirmado exatamente uma vez
- O3: O3 oito consumidores disputando o MESMO e-mail: um lease só, um encaminhamento, uma confirmação
- O4: O4 cota por remetente reservada sob concorrência: 6 e-mails do mesmo remetente => 6 encaminhamentos, 1 confirmação
- O5: O5 teto global sob concorrência: 36 remetentes distintos => exatamente 30 confirmações
- O6: O6 transições: forward_pending (falha+recuo) -> ack_pending (falha+recuo) -> done, uma confirmação só
- O7: O7 limites: 10 falhas de envio, 10 de leitura e 20 leases; estourado => nenhuma leitura/encaminhamento/confirmação da mensagem e vira dead
- O8: O8 limite de 23 h (janela de 24 h da Idempotency-Key): 22h59 ainda tenta; 23h01 vira dead sem leitura/encaminhamento/confirmação
- O9: O9 lease protege a linha do reap e de outro consumidor; vencido o lease, o reap mata sem leitura/encaminhamento/confirmação
- O10: O10 zero leitura, encaminhamento ou confirmação associada à mensagem após estouro, mesmo com consumidores concorrentes repetidos; alerta só com contagens
- O11: O11 alertas (mortas e fila atrasada) reservados atomicamente e privados: um por tipo, só categoria e contagens
- O12: O12 provedor automático: webhook duplicado + 2 drenos concorrentes => 1 encaminhamento (Reply-To do ticket), 0 confirmação, skipped_automated_provider
- O13: O13 encaminhamento obrigatório: com o envio falhando a linha NUNCA vira skipped/done (até morrer como forward_dead)
- O14: O14 orçamentos separados com 404 transitório: leituras falhando não consomem envios; depois encaminha e confirma uma vez
- O15: O15 leitura: 400/422 permanentes e 404 depois da janela => dead sem envio; 429/5xx transitórios
- O16: O16 orçamento global por mensagem: 9 falhas de envio no encaminhamento + falhas na confirmação => ack_dead, encaminhamento preservado
- O18: O18 orçamento global de LEITURA: 9 falhas no encaminhamento + 1 na releitura da confirmação => ack_dead, encaminhamento preservado
- O17: O17 dreno interno: nonce consumido atomicamente no PostgreSQL — pedidos simultâneos com o mesmo nonce => um 200, os demais 409; minuto velho 401

## K3 — equivalência

- **Catálogo original** (ab1052f6): `K3 drain token window widened`, que trocava `for (let d = -5; d <= 5 …)` por `-600…600`. Ele **deixou de existir** quando o esquema de token foi substituído (120-3): HMAC sobre `v1\nPOST\n<caminho>\n<minuto>\n<nonce>`, só o minuto atual ou o anterior. A regra de janela agora é coberta por N1 (minuto futuro aceito), N2 (minuto anterior recusado) e pelo teste de minuto velho (U26).
- **Catálogo 61b7ecf**: a variante `K3 drain signature ignores method/path` trocava a assinatura `signDrainRequest({ method: request.method, path: url.pathname, … })` por `{ method: "POST", path: DRAIN_PATH, … }`. Ela é **equivalente**: o handler devolve `null` se `url.pathname !== DRAIN_PATH` e `405` se `request.method !== "POST"` *antes* de calcular a assinatura (`worker/support-email-forward.mjs`, início de `handleSupportDrainRequest`). No ponto da assinatura, método e caminho são sempre exatamente `POST` e `DRAIN_PATH`, então a substituição por constantes não muda nenhum comportamento.
- Reexecução da variante contra a suíte atual: **0 falhas** (37/37), coerente com a equivalência. As adulterações de método e caminho são mortas por K2/N5, porque o token enviado é assinado com outro valor, e cobertas pelo teste U26.
