# Proposta mínima — governança multiprovedor v2

Status: **proposta inativa**. Este diretório não altera `ops/executor.json`, `.github/workflows/t1-publisher-guard.yml`, branch protection, ambientes, secrets ou publicação.

## Problema comprovado

O gate atual procura texto `session_...` e compara com `authorized_claude_sessions`. Isso identifica uma declaração, mas não autentica o executor. Como Claude, Codex e ChatGPT atualmente aparecem no GitHub por meio da identidade do proprietário, `github.actor`, autor do commit e corpo do PR não distinguem o humano dos agentes.

Consequência: adicionar `Codex-Session` ao mesmo arquivo apenas ampliaria uma lista documental. Não resolveria autenticação e poderia criar uma falsa sensação de controle.

## Modelo proposto

| Papel | Pode | Não pode |
|---|---|---|
| Claude | propor mudanças operacionais, testar e solicitar publicação pela esteira existente | merge, aprovação final, gestão de credenciais ou publicação fora da esteira |
| Codex | propor aquisição somente em `growth/**` e executar testes isolados | workflows, Worker, checkout, financeiro, secrets, merge, deploy ou mensagens |
| ChatGPT | auditar e registrar PASS/FAIL/NÃO COMPROVADO | push, merge, deploy ou credenciais |
| Proprietário | aprovar, fazer merge, aprovar ambiente de produção e gerir credenciais | delegação implícita por texto em PR |
| GitHub Actions | publicar somente pelos workflows canônicos após aprovação do ambiente | ampliar escopo, alterar secrets ou contornar revisão |

## Autenticação e autorização

1. **Principal distinto:** cada executor usa uma instalação GitHub App própria. O login do bot e o installation ID são obtidos pela API do GitHub e registrados; não são escolhidos pelo executor.
2. **Sem credencial humana compartilhada:** o token/sessão do proprietário é removido dos agentes. Enquanto isso não for comprovado, o v2 permanece inativo e toda identidade de provedor é NÃO COMPROVADA.
3. **Permissão efetiva:** um job somente leitura confere, pela API, a instalação associada ao PR e suas permissões. Codex pode escrever conteúdo e PR, mas não administração, Actions, ambientes ou secrets.
4. **Escopo por arquivo:** Codex é aceito somente em `growth/**`. Qualquer arquivo operacional falha fechado, mesmo com identidade válida.
5. **Aprovação do proprietário:** merge exige review APPROVED do proprietário no SHA atual, branch protegida e descarte automático de aprovação após novo commit.
6. **Publicação:** secrets ficam no ambiente protegido `production`. Apenas workflows canônicos entram nesse ambiente, com aprovação manual do proprietário, prevenção de autoaprovação e restrição à branch protegida.
7. **Proveniência textual:** IDs de sessão podem continuar no relatório, mas nunca contam como autenticação ou autorização.

## Verificação pelo GitHub

A implementação futura deve consultar e comparar:

- autor autenticado do PR e instalação GitHub App;
- permissões concedidas à instalação no repositório;
- arquivos alterados no PR;
- review do proprietário ancorado ao `head.sha` atual;
- regras da branch: PR obrigatório, checks obrigatórios, CODEOWNERS e stale reviews;
- configuração do ambiente `production`: revisor obrigatório, prevenção de self-review e branches permitidas;
- workflow solicitante contra allowlist canônica.

Se a API não permitir provar qualquer item, o resultado é **NÃO AUTORIZADO / NÃO COMPROVADO**, nunca PASS por ausência.

## Migração segura

1. Proprietário cria ou instala os três principals separados sem fornecer sua sessão pessoal.
2. Auditor lê logins, installation IDs e permissões efetivas; substitui os placeholders em `policy.proposal.json`.
3. Proprietário configura branch e ambiente protegido.
4. Um PR separado, feito pelo principal correto, propõe a ativação do schema v2 e a adaptação do gate.
5. Testes negativos são obrigatórios; o gate v1 continua ativo até o v2 passar e ser aprovado.
6. Só depois o proprietário decide merge. Não há exceção automática para o #813.

## Testes incluídos

`authorize.test.mjs` demonstra fail-closed para:

- política ainda inativa;
- declaração sem principal autenticado;
- Codex usando a identidade compartilhada do proprietário;
- Codex tocando Worker;
- permissão excessiva;
- aprovação do proprietário em SHA antigo;
- workflow de publicação fora da allowlist;
- caminho válido de aquisição e caminho canônico de deploy protegido.

O workflow deste PR executa somente esses testes com dados fictícios. Ele não usa secrets, não consulta produção e não publica.
