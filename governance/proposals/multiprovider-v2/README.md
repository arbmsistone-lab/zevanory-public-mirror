# Proposta mínima — governança multiprovedor v2

Status: **proposta inativa**. Este diretório e seu CI não alteram `ops/executor.json`, `.github/workflows/t1-publisher-guard.yml`, proteções, ambientes, secrets, merge ou publicação.

## Decisão corrigida

A função `authorize` agora recebe somente um envelope produzido por coletor confiável. Ela não aceita `authenticated_principal`, permissões ou aprovação enviados livremente pelo executor. Ausência, erro, escopo desconhecido ou prova incompleta resulta em **NOT_PROVEN** ou **DENY**, nunca em autorização.

O coletor proposto é separado em `collector.mjs`. Ele consulta PR, arquivos, reviews, permissões, branch e ambiente por interfaces somente leitura. O arquivo deste PR é apenas especificação testável: código vindo do próprio PR não pode ser sua própria raiz de confiança.

## Fronteira de confiança

O coletor ativo deverá:

1. ser instalado pelo proprietário em PR de bootstrap separado;
2. viver na branch padrão protegida e ter SHA fixado na política;
3. executar por `pull_request_target` sem checkout nem execução de código do PR;
4. usar apenas `contents: read`, `pull-requests: read` e `metadata: read`;
5. obter PR, arquivos, reviews e configurações diretamente das APIs;
6. obter o vínculo executor–principal–sessão de registro externo controlado pelo proprietário e de atestado confiável do provedor;
7. propagar erro de API como evidência incompleta.

Um login GitHub App e um installation ID autenticam o principal GitHub, mas **não provam por si sós qual modelo ou sessão operou esse principal**. Sem atestado externo verificável, a identidade do modelo é `NOT_PROVEN`.

## Permissões e caminhos

Cada papel possui `permission_allowlist` e `required_permissions`. A fotografia deve ser exaustiva. O decisor rejeita:

- qualquer permissão não listada;
- nível desconhecido ou superior ao máximo;
- permissão obrigatória ausente;
- fotografia parcial ou não proveniente da API.

Codex normal fica limitado a `growth/**`. `governance/**` e `.github/workflows/**` são proibidos. Portanto, este #814 é um documento excepcional de proposta e **não é elegível para autoativação**. O bootstrap será outro PR, criado/revisado sob controle do proprietário.

## Aprovação real

Auditoria técnica do ChatGPT não equivale a autorização GitHub. Merge requer:

- autor do PR diferente do proprietário;
- review `APPROVED` do proprietário no SHA atual;
- review não descartado;
- branch protection comprovada com PR obrigatório, CODEOWNER e stale reviews descartadas.

Publicação acrescenta workflow canônico e ambiente `production` comprovado, com prevenção de autoaprovação e branch protegida. A regra não presume que o autor consiga aprovar o próprio PR.

## Estado observado em 2026-10-14

| Controle | Evidência disponível | Veredito |
|---|---|---|
| Branch `gh-pages` | endpoint de protection respondeu 403 à integração disponível | **NOT_PROVEN** |
| Rulesets | API retornou lista vazia | nenhum ruleset observado |
| Ambiente `production` | endpoint não disponível pela integração atual | **NOT_PROVEN** |
| Permissões de Actions | endpoint não disponível pela integração atual | **NOT_PROVEN** |
| Vínculo app → modelo/sessão | não há atestado externo verificável | **NOT_PROVEN** |

Disponibilidade de produto não é configuração comprovada. A documentação oficial informa que protected branches existem para repositórios públicos no GitHub Free e que ambientes/protection rules também existem para repositórios públicos; isso apenas indica viabilidade no plano, não prova que estejam ativados aqui:

- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments

## Migração v1 → v2

Opinião: **não migrar ainda**. Manter o `session-guard` v1 inalterado até todos os itens abaixo serem verificáveis:

1. principals separados para Claude, Codex, auditor e proprietário;
2. sessão humana do proprietário indisponível aos agentes;
3. registro externo e atestado de vínculo do executor ativos;
4. permissões efetivas completas dentro das allowlists;
5. collector instalado na branch protegida, revisado, fixado por SHA e sem executar código do PR;
6. branch protection e ambiente `production` legíveis e conformes;
7. testes adversariais e checks obrigatórios verdes;
8. aprovação distinta do proprietário sobre o SHA exato do PR de ativação;
9. publicação possível apenas pelos workflows canônicos.

Após isso, um PR do proprietário pode executar fase de observação em modo `report-only`; outro PR, após auditoria, pode tornar v2 obrigatório. O v1 só deve ser removido em mudança posterior, quando a equivalência operacional estiver demonstrada.

## Impacto sobre #813

O #813 continua draft e sem merge. Para ficar compatível com v2:

- a operação normal do Codex deve conter somente `growth/**`;
- o workflow específico incluído no #813 deve ser removido depois que um workflow genérico confiável for instalado pelo bootstrap;
- sua autoria precisa vir de principal Codex separado com vínculo externo verificável;
- qualquer novo commit invalida aprovação anterior;
- não existe exceção de publicação ou merge.

## Testes adversariais

`authorize.test.mjs` cobre política inativa, resposta de API forjada, SHA divergente, proveniência do chamador, execução de código do PR, vínculo externo ausente, permissões desconhecidas/excessivas/incompletas, caminho fora de `growth/**`, aprovação velha, descartada ou do próprio autor e proteção de branch indisponível.

O workflow deste PR apenas executa testes com fixtures. Não coleta evidência real, não usa secrets e não publica.
