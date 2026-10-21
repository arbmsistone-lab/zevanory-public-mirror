# Validação e evidência do pacote C4

## Comando reproduzível

```sh
node --test growth/codex-conversion-20261014/validate.test.mjs
node growth/codex-conversion-20261014/validate.mjs
```

A suíte contém um caso positivo e doze falhas adversariais: métricas inventadas, evidência desconhecida, pesquisa geral apresentada como dado ZEVANORY, promessa comercial, ranking adulterado, total divergente, expansão de escopo, baseline fabricado, Codex como executor operacional, mídia paga, custo adicional e campo com formato de dado pessoal.

## Evidência coletada

- fonte canônica fixada no SHA `c3717aeb325e7acc6108177426ca420e565bb575`;
- leitura dos módulos de funil, router comercial, catálogo, material gratuito e páginas dos cinco produtos;
- readback GET público de vitrine, material gratuito e Lucro & Caixa;
- nenhum formulário enviado;
- nenhuma rota `/comprar` aberta no navegador;
- nenhum POST, order, pagamento, dado pessoal ou painel administrativo acessado;
- fontes externas registradas com escopo e limitações.

## Limite do CI

Este PR não modifica workflows, conforme a ordem do proprietário. Na base canônica auditada, nenhum workflow existente inclui `growth/codex-conversion-20261014/**` no gatilho nem executa esta suíte. Portanto, checks gerais do GitHub não devem ser apresentados como prova de execução destes testes.

A auditoria deve executar os dois comandos acima em ambiente de nuvem autorizado. Até existir esse recibo, o estado correto é **testes fornecidos, execução C4 não comprovada em CI**.
