# R129 | Correção SW01.6 e avaliação de gates
06/11/2026. PR #973 Draft.

- Entrada confirmada: SHA 5e211d40d3f4834a51b83c50a8fefb0ef4e8f596, ahead 51 / behind 0; mergeable.
- SW01.6 exige literalmente o próprio elemento `ol` com `role="log"`, `aria-live="polite"` e `aria-relevant="additions"`. R128 havia movido a região ao div wrapper, rompendo contrato sem remover o anúncio visual.
- Correção nos três arquivos sincronizados: `ol` volta a ser a região live `log`, cada mensagem `li` passa a ter `role="group"` (não se anuncia como listitem sem pai acessível list), sem mover foco e sem alterar os testes SW01, axe ou workflows.
- Execução anterior (SHA 5e211d4): site-chat-contract run 42209821082 falhou em SW01.6 antes de chegar aos passos PostgreSQL/axe; node-suite-windows executou 1078, 1077 pass e 1 fail idêntico.
- T1 publisher guard run 42209821213: inventory + external-repository sucesso; session-guard e verificacao-com-credencial-pendente falharam por autorização governamental ausente, outras verificações dependentes puladas. Não reclassificar como PASS sem autorização do proprietário.
- Control Center React está no repositório separado zevanory-product-control-edge. A rota provisória `/admin/chat-protocolos` do site não comprova acesso autenticado no Control Center React, nem vínculo SSO ou disponibilidade no domínio de controle. Voto: NO-GO para atendimento humano operacional por essa via até integração React auditada ou aceitação explícita e prova de autenticação/uso real da rota provisória; nenhuma ativação de chat aqui.
- DEC-21 do blog preservada no branch; P18 adiado; vendas fechadas; Facebook por conferir manualmente; Graph API token suspenso. Sem merge, deploy, custo nem credenciais.
- NOVO SHA: a comprovação de 33/33, skipped 0 e Playwright/axe depende de nova execução no GitHub e não é presumida.
