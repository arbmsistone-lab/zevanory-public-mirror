# LIA · P01 Fase A: medição técnica de demanda (legítimo interesse)

Avaliação de Legítimo Interesse (LIA) da medição da Fase A, LGPD (Lei 13.709/2018), art. 7º, IX, e art. 10.
Texto substitutivo da AVAL 101 (Sol), §§ 0 a 7, incorporado sem alteração de conteúdo.

> **Nota:** este texto é uma minuta técnico-documental para revisão do proprietário; não é parecer jurídico. Os
> controles descritos devem existir e ser testados antes da aprovação do hash.

| Campo | Valor |
|---|---|
| Versão: 2 | 23/10/2026 (substitui a versão 1; histórico no git) |
| Estado | **PENDENTE DE REVISÃO JURÍDICA** pelo proprietário. A medição é recusada tecnicamente (503, sem cookie, sem gravação) até esta LIA e o inventário do art. 37 (`docs/lgpd/ROPA-fase-a.md`) estarem aprovados e com os hashes configurados (ver "Aprovação"). |
| Controlador | A. Renan Alves Moreira Bitu Ltda, CNPJ 69.077.233/0001-99 |
| Canal de privacidade | [canal e identidade formal a confirmar pelo proprietário] |
| Inventário (art. 37) | `docs/lgpd/ROPA-fase-a.md` |
| Gatilhos de RIPD (art. 38) | `docs/lgpd/RIPD-gatilhos-fase-a.md` |
| Controles no código | `worker/waitlist.mjs`, `worker/waitlist-public.mjs`, `worker/fase-a-lia.mjs`, `db/migrations/030_waitlist_fase_a.sql`; testes em `tests/fase-a/` |

## 0. Estado e escopo

Esta avaliação trata exclusivamente da medição técnica de demanda da Fase A. O cadastro voluntário na lista de
espera usa consentimento separado, facultativo e revogável e não é abrangido por esta base legal. Enquanto esta LIA,
o inventário do art. 37 e os controles técnicos abaixo não estiverem aprovados pelo proprietário, o endpoint de
medição permanece desabilitado, responde sem registrar dados e a Fase A permanece **NO-GO**.

Base avaliada: legítimo interesse do controlador, nos termos dos arts. 7º, IX, e 10 da LGPD. O resultado desta LIA é
condicional e será revisto quando houver mudança de finalidade, dado, público, fornecedor, região, duração ou
tecnologia.

## 1. Finalidade específica e resultado permitido

Finalidade: comparar, por nicho, a proporção de **navegadores/dispositivos pseudônimos** que acessam as páginas
experimentais durante a janela pré-registrada, para decidir se o experimento deve avançar, ser repetido ou
encerrado. O identificador não representa uma pessoa única: uma pessoa pode usar mais de um dispositivo e várias
pessoas podem compartilhar um dispositivo.

Os dados não serão usados para publicidade comportamental, perfil individual, decisão com efeito sobre o titular,
enriquecimento, contato, venda, compartilhamento comercial ou cruzamento com a lista de espera. A origem de tráfego
será limitada a valores previamente permitidos e usada somente de forma agregada.

## 2. Dados mínimos e necessidade

Dados persistidos permitidos: HMAC de um identificador aleatório first-party do navegador; nicho; origem em
allowlist; primeira e última data; número limitado de visitas; estado de opt-out. A chave HMAC é separada do banco,
rotacionada por janela e acessível apenas ao serviço autorizado.

IP, User-Agent e sinal de ASN podem ser processados transitoriamente para segurança e exclusão de tráfego
automatizado, mas não serão armazenados em formato bruto nem como derivado individual persistente. Qualquer proposta
de persistir código derivado de IP+UA requer nova prova de necessidade, comparação com alternativa agregada menos
invasiva, prazo próprio e nova aprovação desta LIA.

Não são coletados dados sensíveis, geolocalização precisa, conteúdo digitado, histórico de navegação,
identificadores de terceiros ou dados de compra. Não há pixel de terceiro. O sistema não tenta identificar
civilmente o visitante.

## 3. Expectativa e balanceamento

Não se presume relação anterior com o visitante. Por isso, antes de criar o identificador ou registrar a primeira
visita, a página exibe aviso curto e acessível com: controlador e canal; finalidade; dados utilizados; duração;
operadores essenciais; link para esta política; e botão **“Não participar da medição”**.

O experimento não é dirigido a crianças ou adolescentes. Como não se coleta idade por minimização, se o controlador
tomar conhecimento de tratamento relativo a menor, o registro será excluído e a base será reavaliada considerando o
melhor interesse. Segmentação a menores, inferência sensível, cruzamento de bases, perfilamento ou contato individual
são proibidos e obrigam nova LIA/RIPD.

O impacto residual é avaliado como baixo somente enquanto: a finalidade permanecer estatística e limitada; os dados
forem pseudonimizados e minimizados; o aviso anteceder a medição; o opt-out impedir toda gravação; o acesso for
restrito e auditado; e a exclusão automática for comprovada. Falha em qualquer condição suspende a coleta.

## 4. Transparência, opt-out e direitos

O opt-out é oferecido na própria página, sem exigir login ou justificativa. Ao acioná-lo, o sistema grava apenas um
marcador first-party de não participação (`zvfa_optout=1`) pelo período estritamente necessário para honrar a
escolha, apaga o identificador de medição daquele navegador quando tecnicamente localizável e deixa de criar
identificador, HMAC ou evento. A exclusão manual do cookie de medição, isoladamente, não será descrita como opt-out.
Quando o cabeçalho `Sec-GPC: 1` for recebido, o sistema o tratará como não participação na medição.

O canal de privacidade é `[canal e identidade formal a confirmar pelo proprietário]`. Confirmação simplificada será
prestada imediatamente quando possível; resposta completa observará o prazo legal aplicável. Para localizar o
registro, será oferecida ação local ou token opaco gerado no navegador; o titular não será orientado a enviar o valor
bruto do cookie por e-mail. O controlador oferece, além dos direitos legais, opt-out voluntário amplo como
salvaguarda do experimento.

Cloudflare e Neon/Postgres serão identificados na política como operadores/fornecedores de infraestrutura, com
indicação de finalidade, localização/região aplicável, eventual transferência internacional e salvaguardas
contratuais e técnicas. Não haverá divulgação a terceiros para finalidade própria.

## 5. Retenção e eliminação

O cookie de medição expira no encerramento da janela experimental ativa e nunca ultrapassa essa janela. Linhas
pseudônimas são apagadas automaticamente no primeiro dos seguintes eventos: pedido válido; encerramento do
experimento sem continuidade; 30 dias após a decisão documentada; ou 60 dias após o fechamento da janela. Não existe
prorrogação genérica até 180 dias.

Backups expiram em até oito dias sem restauração seletiva posterior ao prazo principal. Cada execução de exclusão
produz registro sem dados pessoais contendo data, escopo, quantidade e resultado. Agregados somente permanecem se
anonimizados de forma razoavelmente irreversível e com supressão de células pequenas que permitam singularização.

## 6. Segurança e governança

Dados são protegidos em trânsito e em repouso; acessos seguem menor privilégio, são nominativos e auditados; chaves
ficam separadas do banco; ambientes e segredos são segregados; logs não contêm identificador bruto; e incidentes
seguem procedimento documentado. O inventário do art. 37 registra controlador, operadores, sistemas, países/regiões,
dados, finalidade, base, acessos, retenção, contratos, incidentes e os SHAs exatos de código e configuração.

O proprietário registra, antes do GO, matriz de risco com probabilidade e gravidade antes/depois das salvaguardas.
Será elaborado ou atualizado RIPD se solicitado pela ANPD ou se surgir menor, dado sensível/inferido, monitoramento
sistemático em escala, fingerprinting, cruzamento de bases, perfilamento, tráfego pago, novo operador/país, nova
finalidade ou incidente relevante.

## 7. Aprovação fail-closed

A ativação exige simultaneamente: texto sem marcador pendente; inventário do art. 37 aprovado; testes do aviso
pré-coleta, opt-out, GPC, minimização e exclusão; hash SHA-256 desta versão gravado em
`FASE_A_LIA_APPROVED_SHA256`; manifesto gerado e verificado; e registro de aprovação do proprietário. Qualquer
divergência de hash, mudança de código/configuração relevante ou falha de salvaguarda desabilita a coleta
automaticamente e exige nova revisão.

## Correspondência com o código (informativa)

| Controle prometido | Onde é implementado e testado |
|---|---|
| Unidade "navegador/dispositivo pseudônimo" | `UNIT` em `worker/waitlist.mjs`; campos `eligible_browsers`, `unit` no resumo |
| Aviso antes da coleta | Folha de estilo do aviso `/lista-de-espera/a/<nicho>.css?aviso=<AVISO_VERSION>` no fim do bloco do aviso; sem ela (ou com outra versão) o núcleo recusa sem gravar nada |
| Não participação (`zvfa_optout=1`) e `Sec-GPC: 1` | `/lista-de-espera/nao-participar` e verificações em `worker/waitlist-public.mjs`; `optOutMeasurement` apaga as linhas localizáveis |
| Sem derivado persistido de IP+UA | IP não chega ao núcleo; UA/ASN só no filtro de robôs; tabela de pessoa-dia removida da migração 030 |
| Retenção (pedido / encerrado sem continuidade / decisão + 30 / janela + 60) | `runWaitlistRetention`, `retentionTriggers`; `FASE_A_CLOSED_NO_CONTINUATION`, `FASE_A_DECISION_DATE`, `window_end` |
| Registro de exclusão sem dado pessoal | tabela `waitlist_deletion_log` |
| Supressão de células pequenas | `SMALL_CELL_K`, `anonymousAggregate`; retenção apaga contadores com 0 < n < 5 ao fim da finalidade |
| Ação local / token opaco | `/lista-de-espera/meus-dados` (código de atendimento) e `scripts/fase_a/atendimento.mjs` |
| Trava LIA + ROPA | `worker/fase-a-lia.mjs`, `worker/fase-a-lia.generated.mjs`, check obrigatório `product-pages / static-audit` |

## Aprovação

Trava técnica (`worker/fase-a-lia.mjs`): a medição só liga se (1) este documento e o ROPA não tiverem nenhum marcador
de pendência, (2) a tabela abaixo (e a do ROPA) tiver uma linha completa com revisor (nome), data `AAAA-MM-DD`, versão
igual à "Versão: N" acima e decisão `APROVADA`, e (3) o proprietário definir no Worker principal
`FASE_A_LIA_APPROVED_SHA256` (e `FASE_A_ROPA_APPROVED_SHA256`) igual ao SHA-256 (texto UTF-8, fins de linha LF) do
arquivo já aprovado, que `node scripts/fase_a/lia_manifest.mjs --write` grava em `worker/fase-a-lia.generated.mjs`.
Qualquer edição posterior muda o SHA-256 e **desliga** a medição até nova aprovação. Automação nunca preenche esta
tabela nem as variáveis.

| Revisor | Data | Versão da LIA | Decisão | Observações |
|---|---|---|---|---|
| _pendente_ | _pendente_ | _pendente_ | _pendente_ | Proprietário: revisar §§ 0 a 7, confirmar canal e identidade formal, registrar a matriz de risco e aprovar aqui antes de ligar a medição. |
