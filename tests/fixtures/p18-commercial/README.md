# Fixtures SINTÉTICAS da verificação comercial P18

Escritas à mão para `tests/p18-commercial.test.mjs`; nenhuma é captura real da Hotmart (a sessão que as escreveu
não alcança pay.hotmart.com). Reproduzem os sinais que o módulo procura: aviso de vendas fechadas (erro 049,
"vendas temporariamente encerradas"), nome do produto, ID do produto em JSON de estado, razão social e CNPJ.
Quando houver captura real (modo live com `--browser`, relatório anexado ao run), acrescentar a captura com a data
e manter estas como casos de borda.
