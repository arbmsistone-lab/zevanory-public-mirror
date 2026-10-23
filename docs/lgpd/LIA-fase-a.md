# LIA · P01 Fase A: medição de demanda da lista de espera (legítimo interesse)

Avaliação de Legítimo Interesse (LIA, *Legitimate Interest Assessment*) exigida pela AVAL 092 §2 para a
medição da Fase A, com base na LGPD (Lei 13.709/2018), art. 7º, IX, e art. 10.

| Campo | Valor |
|---|---|
| Versão: 1 | 23/10/2026, redigida junto do protocolo v4 (`docs/p01/FASE_A_PROTOCOLO.md`) |
| Estado | **PENDENTE DE REVISÃO JURÍDICA** pelo proprietário (ou assessoria por ele indicada). A medição é recusada tecnicamente (503, sem cookie, sem gravação) até a aprovação registrada abaixo e o hash aprovado configurado (ver "Aprovação"). |
| Controladora | A. Renan Alves Moreira Bitu Ltda, CNPJ 69.077.233/0001-99 |
| Encarregado (canal) | suporte@zevanory.api.br |
| Código | `worker/waitlist.mjs`, `worker/waitlist-public.mjs`, migração `db/migrations/030_waitlist_fase_a.sql` |
| Fora do escopo desta LIA | a lista de espera em si (contato, nome, respostas), cuja base legal é o **consentimento** (art. 7º, I), com versão `fase-a-lista-v2-2026-10-22` |

Mudanças nesta avaliação geram nova versão neste arquivo (histórico no git), registrada antes de ligar a coleta.

## 1. Finalidade

**Interesse legítimo da controladora**: decidir, com evidência e sem vender nada, qual de três nichos
(confeitaria, loja de roupas, salão e barbearia) tem demanda suficiente por um kit digital antes de investir na
Fase B. A decisão usa uma regra pré-registrada (conversão de inscrição sobre pessoas experimentais únicas por
nicho), que exige um denominador honesto: sem medir **pessoas** (e não acessos), a conversão seria inflada ou
deflacionada e a decisão seria enviesada.

- Finalidade específica, explícita e informada (art. 6º, I): só medir a demanda da Fase A. Os dados de medição
  **não** são usados para publicidade, perfilamento, remarketing, venda, cruzamento com outras bases nem contato.
- Situação concreta (art. 10, caput): a avaliação de um produto da própria controladora a partir de visitas às
  suas próprias páginas, no período do teste.
- O interesse é **atual** e limitado à janela do teste (21 dias, precedida de uma semana de teste de 7 dias).

## 2. Necessidade

Dados tratados para a medição e por que cada um é necessário (art. 6º, III; art. 10, §1º):

| Dado | Forma guardada | Necessário para | Alternativa menos invasiva considerada |
|---|---|---|---|
| Identificador aleatório do navegador (cookie próprio `zvfa`, 128 bits, `HttpOnly; Secure; SameSite=Lax`, `Path=/lista-de-espera`) | Só `HMAC(WAITLIST_VISITOR_SECRET, id)` truncado (`person_id`); o identificador em claro nunca vai ao banco | Contar a mesma pessoa uma vez por nicho na janela (unidade estatística) | Contar acessos ou pessoa-dia: infla o denominador e foi rejeitado pela AVAL 085 |
| IP e navegador (User-Agent) | **Processados de forma transitória** no Worker; guardado só `HMAC(segredo, dia|IP|UA)` truncado (exposição pessoa-dia, descritiva) | Filtrar robôs/datacenter (mesmo filtro do funil) e medir exposição diária | Não filtrar robôs: contaminaria o denominador |
| ASN do provedor | Não guardado; só a classe de exclusão (`ua`/`asn`) | Filtro de datacenter | Nenhuma |
| Origem do link (`utm_source` de lista fechada, ex.: `ig_post`, `wa_status`) | Rótulo curto na linha pseudônima da pessoa | Verificar mistura de canais entre os braços e separar a classe `wa_owned` (métrica secundária) | Não medir a origem: a comparação entre nichos ficaria sem controle |
| Dias de visita (primeiro/último, contagem) | Datas sem hora | Distinguir retorno de pessoa nova | Nenhuma |

Não há impressão digital de aparelho, geolocalização, coleta de cliques/rolagem, pixel de terceiros nem
compartilhamento com terceiros. Consequência assumida de propósito (minimização): uma pessoa em dois aparelhos conta
como duas unidades, salvo identidade consentida (ver multi-aparelho em §4).

## 3. Balanceamento

Legítimas expectativas e direitos do titular (art. 10, II) contra o interesse da controladora:

- **Expectativa**: quem abre uma página de pré-lançamento espera que a empresa saiba quantas pessoas a viram; não
  espera ser seguido em outros sites nem contatado. A medição fica restrita às páginas `/lista-de-espera/*` (escopo
  do cookie), não segue o titular fora delas e não gera contato.
- **Impacto**: baixo. Os registros não permitem identificar a pessoa sem informação adicional (o segredo e o cookie
  no próprio navegador); não há decisão automatizada sobre o titular (a decisão é sobre o **nicho**, com dados
  agregados); nenhum dado sensível (art. 5º, II) é tratado.
- **Vulnerabilidade**: o público é adulto e profissional (pequenos negócios). Não há segmentação por idade nem oferta
  dirigida.
- **Transparência** (art. 10, §2º): aviso na própria página da lista e seção `id="lista-de-espera"` da Política de
  Privacidade (texto em `docs/p01/FASE_A_PROTOCOLO.md` §8), publicados antes de ligar a medição.
- **Conclusão proposta** (sujeita à revisão jurídica): o interesse é legítimo, o tratamento é necessário e
  proporcional, e as salvaguardas abaixo reduzem o risco ao titular a um nível aceitável.

## 4. Minimização e salvaguardas

- **Natureza do dado**: o `person_id` e o código pessoa-dia (HMAC de IP + navegador) continuam sendo
  **dado pessoal pseudonimizado** (definição do art. 13, §4º): quem tiver o segredo e o cookie, ou o IP e o navegador do dia, pode
  reassociar o registro. Por isso a LGPD se aplica integralmente a eles; o hash **não** os torna anônimos. A origem do
  link isolada não identifica ninguém, mas, gravada na linha pseudônima, segue o mesmo regime.
- **Segredo dedicado** `WAITLIST_VISITOR_SECRET` (≥ 32 bytes, sem nenhum fallback; ausente = nada é contado). Fica só
  nos segredos do Worker, nunca no repositório nem nos logs.
- **Rotação de chaves**:
  - `WAITLIST_VISITOR_SECRET`: **um segredo por janela** (semana de teste e janela de 21 dias), gerado na abertura e
    descartado depois da retenção; nunca reutilizado entre janelas, o que impede ligar pessoas de rodadas diferentes.
    Trocar o segredo **dentro** de uma janela invalida os cookies e transforma pessoas já contadas em novas unidades;
    por isso, em suspeita de vazamento, a rotação é **imediata** e a janela é declarada **INCONCLUSIVO** na ata
    (procedimento operacional; o código não detecta a troca sozinho).
  - Índice do contato (`LEAD_PRIVACY_SECRET`): anel atual + anterior (`LEAD_PRIVACY_SECRET_PREVIOUS`), de modo que a
    rotação não quebra os links de saída já entregues.
- **Retenção** (`RETENTION` no código): identificadores e códigos de medição apagados **30 dias após a decisão** da
  Fase A (`FASE_A_DECISION_DATE`) e, em qualquer caso, no máximo **180 dias**; cookie com validade até o fim da janela,
  no máximo **60 dias**; cópias de segurança internas (backup diário) expiram em até 8 dias. Só contagens agregadas,
  sem identificador (`waitlist_raw_daily`), permanecem.
- **Rotina de exclusão**: `runWaitlistRetention` (`worker/waitlist.mjs`), agendada no `scheduled` do Worker principal,
  1x/dia; cada exclusão é uma instrução SQL atômica que soma só a contagem agregada; coberta por teste com PostgreSQL
  real (`tests/fase-a/waitlist-postgres.test.mjs`, "retenção por finalidade"). Dependência operacional: registrar
  `FASE_A_DECISION_DATE` no dia da decisão; sem ela, vale o teto de 180 dias.
- **Acesso**: só o binding privado do Worker de vendas alcança o endpoint de medição; o resumo é somente leitura e não
  lê nenhuma coluna de contato (`scripts/fase_a/resumo.mjs`).
- **Desligado por padrão**: sem `FASE_A_WAITLIST=on`, nada é tratado.
- **Origem `wa_owned`** (`wa_status`, `wa_lista`): não muda o tratamento; só a classificação estatística (fora da
  métrica primária, reportada como métrica secundária).
- **Multi-aparelho**: nenhum mecanismo liga aparelhos diferentes, exceto o contato que o próprio titular informou com
  consentimento na lista de espera (alias no mesmo nicho). É a opção mais protetiva; o custo é estatístico e
  conservador (protocolo §2.2).
- **Contato exige consentimento separado**: a medição por legítimo interesse **nunca** autoriza contato. Avisar quando
  as vendas abrirem exige a caixa de consentimento (desmarcada por padrão) da lista; o convite para entrevista é outra
  caixa, opcional e desmarcada; nenhuma mensagem é enviada antes da dupla confirmação (P08, issue #871).

## 5. Direitos do titular

Atendidos pelo canal do encarregado (suporte@zevanory.api.br), em até 15 dias (art. 18 e art. 19):

- **Confirmação e acesso** (art. 18, I e II): para a lista de espera, pelo contato informado. Para a medição, o
  registro é pseudônimo e a controladora **não** consegue localizá-lo sem o cookie do próprio navegador.
  O titular pode enviar o valor do cookie `zvfa` para localizar e apagar o registro.
- **Correção, eliminação, anonimização** (art. 18, III, IV e VI): saída da lista por link assinado (apaga todas as
  inscrições do contato numa instrução); registros de medição apagados pela rotina de retenção ou a pedido.
- **Informação sobre compartilhamento** (art. 18, VII): não há compartilhamento; operadores de infraestrutura
  (hospedagem do Worker e banco) tratam os dados em nome da controladora.
- **Revisão de decisão automatizada** (art. 20): não se aplica; nenhuma decisão é tomada sobre o titular.

## 6. Oposição (opt-out)

- **Oposição à medição** (art. 18, §2º): o titular pode apagar ou bloquear o cookie `zvfa` no navegador (cada visita
  sem cookie vira um identificador novo e não confirmado, que **não** entra no denominador) ou pedir a exclusão pelo
  canal do encarregado. A medição nunca condiciona o acesso à página nem a entrada na lista.
- **Saída da lista**: link assinado mostrado na inscrição (`/lista-de-espera/sair`) ou pedido ao encarregado.
- Sinais de automação/prefetch já não são contados.

## Aprovação

Trava técnica (AVAL 099 §2, `worker/fase-a-lia.mjs`): a medição só liga se (1) este documento não tiver nenhum
marcador de pendência, (2) a tabela abaixo tiver uma linha completa com revisor (nome), data `AAAA-MM-DD`, versão
igual à "Versão: N" acima e decisão `APROVADA`, e (3) o proprietário definir no Worker principal
`FASE_A_LIA_APPROVED_SHA256` igual ao SHA-256 (texto UTF-8, fins de linha LF) **deste arquivo já aprovado**, que
`node scripts/fase_a/lia_manifest.mjs --write` grava em `worker/fase-a-lia.generated.mjs`. Qualquer edição posterior
muda o SHA-256 e **desliga** a medição até nova aprovação. Automação nunca preenche esta tabela nem a variável.

| Revisor | Data | Versão da LIA | Decisão | Observações |
|---|---|---|---|---|
| _pendente_ | _pendente_ | _pendente_ | _pendente_ | Proprietário / assessoria jurídica: revisar §1 a §6, confirmar o texto da Política de Privacidade e registrar aqui antes de ligar a medição. |
