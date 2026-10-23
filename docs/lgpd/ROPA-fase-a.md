# ROPA · P01 Fase A: registro das operações de tratamento (LGPD, art. 37)

Minuta do inventário exigido pela AVAL 101 (lacuna 11) para a medição técnica de demanda e a lista de espera da
Fase A. Não é parecer jurídico.

| Campo | Valor |
|---|---|
| Versão: 1 | 23/10/2026 |
| Estado | **PENDENTE DE REVISÃO JURÍDICA** pelo proprietário. A medição permanece recusada (503) até este registro e a LIA estarem aprovados e com os hashes configurados (`FASE_A_ROPA_APPROVED_SHA256`, `FASE_A_LIA_APPROVED_SHA256`). |
| LIA | `docs/lgpd/LIA-fase-a.md` |
| Gatilhos de RIPD | `docs/lgpd/RIPD-gatilhos-fase-a.md` |

## 1. Controlador e canal

- Controlador: A. Renan Alves Moreira Bitu Ltda, CNPJ 69.077.233/0001-99, Rua Francisco de Freitas Neto, 96, Alto do
  Tenente, Várzea Alegre/CE, CEP 63540-000.
- Canal de privacidade: [canal e identidade formal a confirmar pelo proprietário]. `suporte@zevanory.api.br` é o
  canal de atendimento publicado; só será chamado de encarregado após designação formal.

## 2. Operações registradas

| # | Operação | Finalidade | Base legal | Titulares |
|---|---|---|---|---|
| O1 | Medição técnica de demanda por navegador/dispositivo pseudônimo | Comparar nichos na janela pré-registrada | Legítimo interesse (art. 7º, IX; art. 10), LIA v2 | Visitantes das páginas `/lista-de-espera/*` que não recusaram a medição |
| O2 | Lista de espera (aviso de abertura de vendas) | Avisar se as vendas do kit abrirem | Consentimento (art. 7º, I), versão `fase-a-lista-v2-2026-10-22` | Quem se inscreve voluntariamente |
| O3 | Convite opcional para entrevista | Pesquisa qualitativa | Consentimento separado e opcional | Quem marca a caixa opcional |
| O4 | Registro de exclusões e contadores agregados | Prova de exclusão e oráculo estatístico | Cumprimento de obrigação/legítimo interesse; sem dado pessoal | Nenhum (agregado) |

## 3. Dados por operação

- O1: HMAC (`WAITLIST_VISITOR_SECRET`) de identificador aleatório first-party; nicho; origem em allowlist; primeira e
  última data; número de dias; confirmação; código opaco de atendimento (HMAC); fim da janela. **Não** persistidos: IP,
  User-Agent, ASN ou qualquer derivado individual de IP+UA (usados só em memória para o filtro de robôs). Marcador
  `zvfa_optout=1` fica apenas no navegador do titular.
- O2/O3: contato (WhatsApp ou e-mail), nome opcional, duas respostas sim/não, nicho, versão e data do consentimento,
  índice HMAC do contato, origem (rótulo), opção de entrevista.
- O4: data, escopo, gatilho, quantidade, resultado; contadores por dia/nicho/métrica.
- Nenhum dado sensível, de criança/adolescente por direcionamento, geolocalização precisa ou dado de pagamento.

## 4. Sistemas, operadores, regiões e transferências

| Sistema | Papel | Operador | Região / localização | Transferência internacional | Contrato / salvaguarda |
|---|---|---|---|---|---|
| Worker de vendas (`vendas.zevanory.api.br`) e Worker principal (binding `waitlist.internal`) | Processamento das requisições (memória) | Cloudflare, Inc. | Rede global da Cloudflare (processamento no ponto de presença mais próximo do visitante; [região de dados a confirmar pelo proprietário]) | Possível (art. 33); [mecanismo a confirmar: cláusulas contratuais/DPA da Cloudflare] | [DPA/termos da Cloudflare a anexar pelo proprietário] |
| KV `ZEVANORY_PRIVATE_ARTIFACTS` (marcadores operacionais e cópia de segurança diária) | Armazenamento operacional | Cloudflare, Inc. | [região a confirmar pelo proprietário] | Possível (art. 33) | [DPA a anexar]; backup expira em até 8 dias |
| Banco PostgreSQL (tabelas `waitlist_*`, migração 030) | Armazenamento | Neon (Databricks, Inc.) | [região do projeto Neon a confirmar pelo proprietário no painel] | Se a região for fora do Brasil, transferência internacional (art. 33) | [DPA da Neon a anexar pelo proprietário] |
| GitHub (código e CI) | Código-fonte e testes com dados sintéticos | GitHub, Inc. | EUA | Não recebe dados pessoais reais da Fase A | n/a |

Não há divulgação a terceiros para finalidade própria, pixel de terceiro nem venda de dados.

## 5. Acessos

- Endpoint de medição: somente pelo binding privado do Worker de vendas.
- Banco: credencial `DATABASE_URL` do Worker principal; leitura operacional só pelo resumo somente leitura
  (`scripts/fase_a/resumo.mjs`, transação `read only`, sem colunas de contato) e atendimento por código opaco
  (`scripts/fase_a/atendimento.mjs`). [Lista nominativa de pessoas com acesso a confirmar pelo proprietário.]
- Segredos: `WAITLIST_VISITOR_SECRET` (um por janela), `LEAD_PRIVACY_SECRET` (+ anterior), segregados do banco.

## 6. Retenção e exclusão

| Dado | Gatilho de exclusão (o primeiro que ocorrer) | Mecanismo |
|---|---|---|
| Medição (O1) | pedido válido; encerramento sem continuidade (`FASE_A_CLOSED_NO_CONTINUATION`); 30 dias após a decisão (`FASE_A_DECISION_DATE`); 60 dias após o fim da janela (`window_end`) | `runWaitlistRetention` (diário), `optOutMeasurement`, `atendimento.mjs --apagar` |
| Lista de espera (O2/O3) | saída pelo link assinado; encerramento sem continuidade; 30 dias após a decisão; 12 meses após a inscrição | `revoke`, `runWaitlistRetention` |
| Cookie `zvfa` | fim da janela ativa (nunca depois) | atributo `Max-Age` |
| Marcador `zvfa_optout` | fim da janela ativa | atributo `Max-Age` |
| Cópias de segurança | até 8 dias | TTL do backup diário |
| Contadores agregados | ao fim da finalidade, células com 0 < n < 5 são apagadas; o restante é agregado anonimizado | `runWaitlistRetention`, `anonymousAggregate` |

Toda exclusão grava `waitlist_deletion_log` (data, escopo, gatilho, quantidade, resultado; sem dado pessoal).

## 7. Segurança e incidentes

- Trânsito: HTTPS; repouso: criptografia do provedor; chaves HMAC fora do banco; logs sem identificador bruto.
- Incidentes: [procedimento documentado a anexar pelo proprietário: avaliação, contenção, registro e comunicação à
  ANPD/titulares quando cabível (art. 48)]. Registro de incidentes: [local a definir].

## 8. Versões de código e configuração

| Item | Valor |
|---|---|
| SHA do código aprovado (`worker/waitlist.mjs` e dependências) | [SHA do commit a registrar na aprovação] |
| SHA da LIA aprovada | [igual a `FASE_A_LIA_APPROVED_SHA256` na aprovação] |
| SHA deste ROPA aprovado | [igual a `FASE_A_ROPA_APPROVED_SHA256` na aprovação] |
| Configuração (`FASE_A_WINDOW_ID`, `FASE_A_WINDOW_END`, `FASE_A_DECISION_DATE`, `FASE_A_CLOSED_NO_CONTINUATION`) | [valores a registrar na aprovação, sem segredos] |

## Aprovação

Mesma trava da LIA (`worker/fase-a-lia.mjs`): sem marcador de pendência, linha completa abaixo (revisor, data
`AAAA-MM-DD`, versão igual à "Versão: N" acima, `APROVADA`) e `FASE_A_ROPA_APPROVED_SHA256` igual ao SHA-256 deste
arquivo aprovado. Automação nunca preenche esta tabela nem a variável.

| Revisor | Data | Versão do ROPA | Decisão | Observações |
|---|---|---|---|---|
| _pendente_ | _pendente_ | _pendente_ | _pendente_ | Proprietário: preencher regiões, contratos, acessos e procedimento de incidentes; aprovar aqui antes de ligar a medição. |
