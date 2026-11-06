# R128 | CI do chat e diagnóstico verificável
06/11/2026. PR #973 Draft, branch `gpt6/r120-chat-online-dec20-draft`.

## Estado Git comprovado
O commit `6ae6d207494d4be9a3b6f483ba48338d4548c952` já incorporou o merge do gh-pages `0a724e1` (DEC-21 do PR #972). Comparação atual: 0 behind; branch mergeable. Não repetir merge, rebase ou alterar gh-pages. Preservar `ensureDailyBlog` apenas em modo draft, com seus testes negativos.

## Causa específica do CI
Execução site-chat-contract 42130688597, job 127606216710: PostgreSQL de protocolo ZEV passou; axe-core no Chromium 360px falhou com `document-title` e `listitem`. A correção atribui título explícito à página HTML sintética do ensaio e preserva a semântica nativa da lista ordenada `ol > li`, colocando `role=log` num contêiner ao redor. Arquivos-fonte e cópias públicas alinhados. Não remover regras axe, não ignorar violações.

## Pendências verificadas
O helper `readTextNormalized` já aparece em `tests/r120-dec20-chat.test.mjs`. O workflow `site-chat-contract` já executa PostgreSQL 16 efêmero com o caso R122 e Chromium/axe, mantendo logs como artifact. Somente a nova execução do CI em SHA exato poderá provar PASS da correção.

A tela `/admin/chat-protocolos` é provisória e NÃO equivale à integração React no Control Center separado em `controle.zevanory.api.br`. Esta pendência continua NO-GO. Outro bloqueio do CI: `T1 publisher guard`, run 42130688242, com session-guard e exigência de verificação pós-merge. Avaliar separadamente, sem enfraquecer barreiras.

## Governança
DEC-23/P18 adiado; cron portátil desligado. Meta Graph API suspensa, sem usar META_SYSTEM_TOKEN; Facebook pendente de inspeção manual pelo proprietário. Ligações ARBM → ZEVANORY: inventário somente leitura. Nenhum merge, deploy, segredo, ativação de venda, alteração de produção ou despesa autorizada.
