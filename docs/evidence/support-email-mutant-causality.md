# Causalidade dos mutantes do suporte@ (#900)

Gerado de `scripts/ci/mutants_support_email_allow.json` (suíte unitária) e `scripts/ci/mutants_support_email_pg_allow.json` (PostgreSQL 16 real).

As listas causais foram escritas por **raciocínio sobre cada mutação**: qual regra o mutante quebra e qual teste a verifica diretamente. Elas **não** foram derivadas de falhas observadas.

## Classificador

Os dois runners (`--suite unit` e `--suite pg`) usam o classificador **compartilhado** `scripts/ci/mutant_classifier.py` (#901), sem modificação. A config de cada suíte (`mutants`) está no formato de `load_mutant_config`. Cada primária nomeia o teste **e** o marcador da asserção (`[Unn.k]`/`[Onn.k]`, presente na mensagem da asserção), e esse marcador é conferido **dentro** do bloco `not ok` daquele teste.

- **KILLED** exige asserção primária casada.
- **INCONCLUSIVE** em todos estes casos:
  - outra asserção do mesmo teste primário;
  - falha só em secundário;
  - falha fora da lista;
  - todo/skip/cancelled;
  - contagem de pontos incoerente com o plano ou o resumo;
  - TAP truncado, queda, sintaxe, timeout ou sinal.
- Validação antes de rodar (exit 2): config inválida, primária sem marcador, `test_pattern` inexistente.

As contraprovas específicas de #900 estão em `tests/test_mutants_support_email_classifier.py`:
- (a) outra asserção do teste primário;
- (b) todo e `t.todo`;
- (c) ponto removido, plano adulterado, resumo adulterado ou ausente.

Os marcadores foram escolhidos lendo cada teste antes de rodar o mutante. Na primeira execução estrita, 7 mutantes (D6, X4, B5, C3, K6, WS2, G3) falharam numa asserção anterior do mesmo teste primário. Para cada um, o marcador foi corrigido rastreando o código, e a justificativa está na própria linha. Exemplo: em K6 só cai a linha `if (drained) return drained`, então a asserção da forma do bloco (`[U23.8]`) é a direta, não a da posição da rota (`[U23.7]`).

## Suíte unitária (104 mutantes)

| mutant_id | mudança introduzida | asserção primária (teste + marcador) | justificativa causal | contraprova |
|---|---|---|---|---|
| A1 | alerta de mortas nunca é enviado | **U12** `[U12.2]` — um alerta 'não entregues' | U27 (secundário): afirma alerta de morte exatamente uma vez após ack_dead | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| A2 | limite de alerta removido | **U12** `[U12.9]` — limite de 6 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| A3 | vaga de alerta não liberada após falha | **U12** `[U12.8]` — vaga liberada após a falha | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| A4 | mortas não marcadas como alertadas | **U12** `[U12.6]` — não repete o mesmo morto | U27 (secundário): afirma alerta de morte exatamente uma vez após ack_dead | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| A5 | ignora o limiar de quantidade da fila | **U12** `[U12.8]` — alerta com 5 pendentes recentes | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| A6 | ignora o limiar de idade da fila | **U12** `[U12.11]` — alerta com 1 pendente antigo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B1 | lease ignora tentativas/janela (SQL) | **U15** `[U15.4]` — lease: orçamento | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B2 | orçamento em código ignora tentativas | **U10** `[U10.5]` — zero chamada com attempts > MAX | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B3 | orçamento em código ignora a janela | **U10** `[U10.5]` — zero chamada com idade >= 23 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B4 | remove o reap | **U10** `[U10.3]` — o cron marca como morta sem tentar | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B5 | janela além da Idempotency-Key (48 h) | **U10** `[U10.8]` — withinBudget falso com idade de 23 h literal (o resto do teste usa a constante mutada) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| B6 | due ignora o orçamento (SQL) | **U16** `[U16.4]` — due: orçamento | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| C1 | motivos colapsados | **U24** `[U24.5]` — last_reason por status<br>**U33** `[U33.2]` — last_reason 404 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| C2 | não alerta chave recusada | **U24** `[U24.9]` — alerta de chave recusada em 401/403 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| C3 | 401 não é permissão de chave | **U24** `[U24.{4,5}]` — 401 é configuração (retenta, forward_pending) e motivo content_http_401_key_permission; mal classificado vira permanente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| C4 | não grava last_reason | **U24** `[U24.5]` — row.last_reason<br>**U33** `[U33.2]` — last_reason de 404 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| C5 | classes de rede perdidas | **U33** `[U33.11]` — content_timeout/network_dns/network_reset | U24 (secundário): afirma content_network para fetch lançado | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D1 | lease sem condição de estado (SQL) | **U15** `[U15.1]` — lease: estado pendente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D2 | falha da confirmação conclui a linha | **U07** `[U07.1]` — state ack_pending após a falha da confirmação | U27 (secundário): espera que a falha da confirmação conte para ack_dead; concluir vira done<br>U28 (secundário): espera ack_pending após a falha de envio da confirmação | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D3 | falha de envio do encaminhamento vira morte imediata | **U06** `[U06.2]` — state forward_pending após uma falha<br>**U08** `[U08.3]` — MAX_SEND_FAILURES tentativas antes de forward_dead | U12 (secundário): o alerta de fila atrasada depende de pendências mantidas por falhas transitórias de encaminhamento<br>U25 (secundário): a linha de contagem do dreno espera done=1 após uma falha transitória de encaminhamento<br>U26 (secundário): o dreno autenticado espera concluir um encaminhamento que falhou uma vez<br>U27 (secundário): o cenário 9+1 exige 9 falhas de encaminhamento retentadas<br>U32 (secundário): o caso do provedor automático exige retentar o encaminhamento<br>U34 (secundário): o orçamento separado exige falhas de encaminhamento retentadas<br>U36 (secundário): a fila vencida é construída com falhas de encaminhamento retentadas<br>*broad_reason:* retentar uma falha transitória de encaminhamento é pré-condição desses cenários; a morte prematura remove a pré-condição | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D4 | lease ignora o recuo (SQL) | **U15** `[U15.2]` — lease: recuo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D5 | lease ignora a exclusividade (SQL) | **U15** `[U15.3]` — lease: exclusividade | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D6 | nunca marca *_dead | **U10** `[U10.6]` — forward_dead quando o código detecta orçamento estourado<br>**U33** `[U33.{5,7}]` — forward_dead para os casos permanentes (404 tardio é o primeiro do teste; 400/422) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D7 | remove a Idempotency-Key do encaminhamento | **U06** `[U06.8]` — idem support-fwd/<id> em todas as tentativas<br>**U02** `[U02.9]` — idem support-fwd/em-1 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D8 | remove a Idempotency-Key da confirmação | **U07** `[U07.9]` — idem support-ack/<id> em todas as tentativas<br>**U02** `[U02.16]` — idem support-ack/em-1 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D9 | webhook responde 503 quando o passo falha | **U06** `[U06.1]` — status 200 com registro durável | U24 (secundário): afirma 200 quando a leitura falha<br>U05 (secundário): a redelivery da linha concluída recebe not_due; o mutante devolve 503 | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| D10 | remove o despacho do dreno no cron | **U23** `[U23.3]` — dreno despachado no ramo horário | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F1 | remove o Reply-To do encaminhamento | **U02** `[U02.7]` — reply_to do encaminhamento = [cliente]<br>**U30** `[U30.2]` — reply_to do encaminhamento por caso | U37 (secundário): o teste de corpo não confiável também afirma reply_to = [cliente] | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F2 | remove o prefixo do assunto | **U02** `[U02.8]` — assunto '[ZEVANORY suporte] …' | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F3 | destino fixo quando não configurado | **U03** `[U03.4]` — 503 sem destino | U25 (secundário): o dreno sem destino precisa registrar skipped unconfigured; o destino fixo o torna configurado | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F4 | aceita destino no próprio domínio | **U03** `[U03.4]` — 503 para destino suporte@ | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F5 | remove o alias contato@ | **U03** `[U03.1]` — contato@ é tratado | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F6 | registra o texto no log sem confirmação | **U13** `[U13.4]` — log sem conteúdo nos casos automáticos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| F7 | usa a chave de envio para ler recebidos | **U24** `[U24.3]` — GET com Bearer da chave de leitura<br>**U02** `[U02.11]` — Bearer re_full_receiving na leitura | U09 (secundário): afirma a chave de leitura vinda do KV no GET | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G1a | remetente pelo cabeçalho do corpo | **U31** `[U31.4]` — confirmação ao cliente quando só o cabeçalho diz WhatsApp | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G1b | aceita vários endereços | **U31** `[U31.3]` — providerAddress vazio para listas | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G2a | Reply-To com dois destinatários | **U30** `[U30.1]` — remetente no caso de dois destinatários | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G2b | Reply-To com CRLF/lista | **U30** `[U30.1]` — remetente nos casos CRLF/lista | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G2c | Reply-To do cabeçalho | **U30** `[U30.1]` — remetente quando o ticket só está no cabeçalho | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G3 | skipped com encaminhamento falhando | **U32** `[U32.{1,2}]` — linha continua forward_pending e ack_status null com o encaminhamento falhando | U36 (secundário): a fila vencida usa remetente WhatsApp com encaminhamento falhando; o mutante conclui a linha | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G5a | 404 permanente de imediato | **U33** `[U33.1]` — forward_pending após 404 | U24 (secundário): afirma forward_pending para 404 | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G5b | 404 transitório para sempre | **U33** `[U33.5]` — forward_dead para 404 tardio | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G5c | 400/422 transitórios | **U33** `[U33.7]` — forward_dead para 400/422 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G5d | 429/5xx permanentes | **U33** `[U33.9]` — forward_pending para 429/5xx | U24 (secundário): afirma forward_pending para 429/5xx | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G6 | orçamento compartilhado no SQL de retry | **U18** `[U18.2]` — retry: contador de envio por tipo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G6b | código soma os contadores | **U34** `[U34.4]` — o envio teve as suas próprias tentativas | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G7 | chamada à supressão global | **U35** `[U35.{1,3}]` — nenhum caminho fora de /emails e /emails/receiving | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G8a | email_id no log | **U36** `[U36.1]` — id ausente do log do cron | U24 (secundário): afirma log sem 'em-1' nos motivos de leitura | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G8b | overdue nunca marcado | **U36** `[U36.4]` — overdue true com fila >= 2 h | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G8c | cron verde com fila vencida | **U23** `[U23.9]` — fila vencida deixa o cron vermelho | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| G9 | Reply-To tirado do corpo | **U37** `[U37.3]` — reply_to = [cliente] apesar do corpo | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| H1 | hash simples em vez de HMAC | **U04** `[U04.1]` — sender_ref = HMAC | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| H2 | aceita sem segredo de privacidade | **U04** `[U04.4]` — 503 sem LEAD_PRIVACY_SECRET | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| I1 | 409 idempotente tratado como falha | **U11** `[U11.1]` — state done após 409 idempotente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K1 | dreno não registra a execução | **U25** `[U25.1]` — uma linha 'drain' por execução | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K2 | assinatura do dreno não conferida | **U26** `[U26.{4,5,6}]` — 401 para caminho/método/segredo adulterados | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K4 | dispatch nunca usa SELF | **U26** `[U26.29]` — dispatch via SELF responde 200 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K5 | classe de erro do dreno perdida | **U25** `[U25.7]` — error too_many_subrequests | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K6 | rota do dreno removida | **U23** `[U23.8]` — o bloco da rota devolve a resposta do handler (if (drained) return drained) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| K7 | dreno despachado depois do preflight | **U23** `[U23.4]` — antes do preflight | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| L1 | ignora Auto-Submitted | **U13** `[U13.2]` — sem confirmação para Auto-Submitted | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| L2 | ignora o veredito de automação | **U13** `[U13.2]` — sem confirmação nos casos automáticos<br>**U29** `[U29.1]` — ack skipped_automated_provider | U31 (secundário): afirma supressão quando o metadado diz WhatsApp<br>U32 (secundário): afirma 0 confirmação para o provedor automático | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| L4 | confirma no-reply/mailer-daemon | **U13** `[U13.2]` — sem confirmação para no-reply | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| L5 | confirma o próprio domínio | **U13** `[U13.2]` — sem confirmação para contato@ | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| L6 | confirmação sem Auto-Submitted | **U02** `[U02.17]` — header Auto-Submitted: auto-replied | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N1 | aceita minuto futuro | **U26** `[U26.3]` — minuto futuro => 401 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N2 | recusa o minuto anterior | **U26** `[U26.27]` — minuto anterior => 200 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N3 | aceita replay | **U26** `[U26.13]` — replay => 409 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N4 | aceita corpo não vazio | **U26** `[U26.20]` — corpo não vazio => 400 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N5 | muda a string canônica | **U26** `[U26.22]` — drainCanonical = v1\nPOST\n… | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N6 | nonce frouxo | **U26** `[U26.18]` — nonce maiúsculo => 401 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| N7 | cabeçalho interno autentica | **U26** `[U26.1]` — x-zevanory-internal sem token => 401 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| O1 | encaminhamento sai do endereço do dono | **U02** `[U02.6]` — from = suporte@ no encaminhamento | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| O2 | Reply-To da confirmação aponta para o dono | **U02** `[U02.15]` — reply_to = [suporte@] na confirmação | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| O3 | confirmação sai do endereço do dono | **U02** `[U02.14]` — from = suporte@ na confirmação | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| P1 | trata prova-sandbox@ aqui | **U22** `[U22.1]` — null para prova-sandbox@ | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| P2 | engole eventos de entrega | **U22** `[U22.1]` — null para email.delivered | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| P3 | consome o corpo original | **U22** `[U22.2]` — bodyUsed false | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| Q1 | cota por remetente não aplicada | **U14** `[U14.4]` — on conflict do nothing na vaga do remetente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| Q2 | teto diário não aplicado | **U14** `[U14.5]` — n < $3 no teto global | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| Q3 | vaga global sem vaga do remetente | **U14** `[U14.6]` — vaga global depende de s | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| Q4 | sem trava da linha | **U14** `[U14.2]` — for update | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| R1 | aceita sem chave de leitura | **U09** `[U09.1]` — 503 sem chave de leitura | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| S1 | não confere a assinatura Svix | **U01** `[U01.1]` — status 401 para assinatura inválida/ausente | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| S2 | ignora a tolerância de 5 min | **U01** `[U01.1]` — status 401 para carimbo vencido | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| S3 | aceita qualquer valor v1 | **U01** `[U01.1]` — status 401 para assinatura de outro segredo/corpo | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| S4 | aceita segredo sem whsec_ | **U01** `[U01.1]` — status 401 para segredo fora do formato | só primário | falha só em U02 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| U1 | contadores zerados na transição (SQL) | **U19** `[U19.1]` — SQL de transição não zera contadores | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| U2 | contadores zerados na cadeia | **U19** `[U19.2]` — cadeia stepAck não zera contadores | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| W1 | Reply-To do ticket ignorado | **U30** `[U30.1]` — forwardReplyTo = ticket no caso válido | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| W2 | limites de dígitos removidos | **U30** `[U30.1]` — forwardReplyTo = remetente para 4/21 dígitos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| W3 | Reply-To do ticket para qualquer remetente | **U30** `[U30.1]` — forwardReplyTo = cliente quando o remetente não é o WhatsApp | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| WS1 | WhatsApp não suprimido | **U29** `[U29.1]` — ack skipped_automated_provider | U31 (secundário): afirma supressão quando o metadado diz WhatsApp<br>U32 (secundário): afirma 0 confirmação para o provedor automático | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| WS2 | supressão por sufixo | **U29** `[U29.{5,6}]` — domínio parecido e xsupport@ não são suprimidos (comparação exata) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X1 | mantém o conteúdo de <script> | **U20** `[U20.1]` — padrões proibidos ausentes da saída (alert() | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X2 | permite qualquer tag | **U20** `[U20.{1,4}]` — tags proibidas ausentes / só tags permitidas | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X3 | permite href javascript: | **U20** `[U20.1]` — javascript: ausente | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X4 | não itera a remoção aninhada | **U20** `[U20.{1,3}]` — <scr<script>… reconstruído: sem iteração o <script> remontado cai na regra de tag aberta e apaga o conteúdo legítimo seguinte (<b>fim</b>, U20.3) | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X5 | sem teto de saída do HTML | **U20** `[U20.6]` — html omitido acima do teto | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X6 | aceita extensão executável | **U21** `[U21.1]` — lista de aceitos sem executáveis | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X7 | aceita content-type executável | **U21** `[U21.1]` — lista de aceitos sem x-msdownload | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X8 | aceita tamanho desconhecido/zero | **U21** `[U21.1]` — lista de aceitos sem tamanho ausente/0 | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X9 | sem teto de quantidade | **U21** `[U21.1]` — no máximo 5 aceitos | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| X10 | sem teto total de bytes | **U21** `[U21.3]` — teto total de bytes | só primário | falha só em U01 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |

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

| mutant_id | mudança introduzida | asserção primária (teste + marcador) | justificativa causal | contraprova |
|---|---|---|---|---|
| PA1 | limite atômico do alerta removido | **O11** `[O11.1]` — um único alerta com 3 drenos | O16 (secundário): afirma alerta de morte exatamente uma vez<br>O18 (secundário): afirma alerta de morte exatamente uma vez<br>O10 (secundário): afirma no máximo 1 alerta operacional | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PG6 | falha de leitura também incrementa send_failures | **O14** `[O14.1]` — read_failures 3 e send_failures 0 após 3 falhas de leitura | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PL1 | lease sem exclusividade | **O3** `[O03.1]` — 7 consumidores recebem not_due<br>**O2** `[O02.1]` — 1 encaminhamento por e-mail com 2 drenos | O9 (secundário): afirma not_due com lease ativo<br>O8 (secundário): roda 2 drenos simultâneos e afirma 1 encaminhamento<br>O12 (secundário): webhook duplicado + 2 drenos simultâneos e afirma 1 encaminhamento<br>*broad_reason:* o lease é a única guarda de concorrência; todo teste com consumidores simultâneos e exatamente-uma-vez o observa | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PN1 | nonce sem ON CONFLICT | **O17** `[O17.1]` — [200, 409, 409, 409, 409] com o mesmo nonce | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PQ1 | vaga do remetente reservada mais de uma vez | **O4** `[O04.2]` — 1 confirmação para 6 e-mails do mesmo remetente | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PQ2 | teto global ignorado | **O5** `[O05.2]` — exatamente 30 confirmações | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PR1 | reap removido | **O7** `[O07.5]` — *_dead pelo dreno para linhas estouradas<br>**O8** `[O08.3]` — forward_dead para a linha de 23h01<br>**O9** `[O09.3]` — forward_dead depois que o lease vence | O10 (secundário): afirma *_dead para linhas fora do orçamento<br>O11 (secundário): o alerta de mortas só existe se as linhas virarem dead pelo reap<br>*broad_reason:* o reap é o único caminho de linha pendente fora do orçamento para *_dead | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |
| PU1 | zera read_failures/send_failures na transição para ack_pending | **O16** `[O16.1]` — state ack_dead com send_failures 10 após 9+1<br>**O18** `[O18.1]` — read_failures 9 preservado na transição | só primário | falha só em O1 (fora da lista) ⇒ INCONCLUSIVE; outra asserção do mesmo teste primário ⇒ INCONCLUSIVE |

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

## K3 — arquivo e equivalência

| catálogo | id | mudança | situação |
|---|---|---|---|
| original (ab1052f6) | `K3 drain token window widened` | `for (let d = -5; d <= 5 …)` → `-600…600` (janela de ±5 min do token antigo) | **obsoleto**: o esquema de token foi substituído em 120-3 (HMAC sobre `v1\nPOST\n<caminho>\n<minuto>\n<nonce>`, só o minuto atual ou o anterior). A regra de janela é coberta por **N1** (minuto futuro), **N2** (minuto anterior) e pela asserção `[U26.2]` (minuto velho) |
| 61b7ecf (candidato) | `K3 drain signature ignores method/path` | `signDrainRequest({ method: request.method, path: url.pathname, … })` → `{ method: "POST", path: DRAIN_PATH, … }` | **equivalente, removido**: `handleSupportDrainRequest` devolve `null` se `url.pathname !== DRAIN_PATH` e `405` se `request.method !== "POST"` **antes** de assinar. No ponto da assinatura os valores são sempre esses, então a substituição não muda comportamento. Reexecutado contra a suíte: 37/37, sem falhas. Adulterações de método e caminho continuam mortas por **K2** (`[U26.{4,5,6}]`) |
| atual (este head) | — | — | sem K3. As regras de K3 estão em K2, N1, N2 e N5 |
