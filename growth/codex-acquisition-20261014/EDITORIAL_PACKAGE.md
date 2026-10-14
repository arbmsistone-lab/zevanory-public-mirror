# Entrega editorial das campanhas C1–C3

Esta pasta mantém o PR #815 congelado e acrescenta, em um PR draft empilhado, o pacote editorial revisável das duas campanhas já aprovadas.

## Inventário

| Campanha | Brief SEO | Roteiro YouTube | Roteiro TikTok | Texto Telegram | Texto Bluesky | Medição |
|---|---:|---:|---:|---:|---:|---|
| Fluxo de Caixa / Pix | final para revisão | final para produção | final para produção | final para revisão | final para revisão | 5/5 |
| WhatsApp / Clientes | final para revisão | final para produção | final para produção | final para revisão | final para revisão | 0/5, bloqueada |

“Final” descreve o estágio editorial do texto ou roteiro. Não significa peça visual renderizada, aprovação do proprietário, agendamento ou publicação.

## Arquivos

- `editorial-manifest.json`: contrato de estágio, segurança, marca e aprovação dos dez ativos.
- `editorial-fluxo-caixa-pix.md`: brief, dois roteiros e dois textos da campanha Lucro & Caixa.
- `editorial-whatsapp-clientes.md`: brief, dois roteiros e dois textos da campanha Vendas na Prática.
- `CLAUDE_HANDOFF_WHATSAPP_MEASUREMENT.md`: dependência operacional dos três guias, destinada à frente Claude.
- `validate-editorial.mjs` e `validate-editorial.test.mjs`: validação fail-closed do pacote e testes adversariais.

## Gate objetivo de publicação

Um ativo só pode seguir para divulgação quando todos os oito critérios do manifesto tiverem evidência: aprovação do proprietário, destino/UTM conferidos, alegações revisadas, marca validada, limites do canal conferidos, medição disponível, prévia humana e uso da esteira canônica.

A campanha WhatsApp tem um bloqueio adicional: os três guias precisam ser instrumentados e comprovados em PR operacional separado. Este PR não altera funil, Worker, workflow, checkout, pagamentos ou credenciais.

## Execução dos testes

O workflow já existente no PR #813 chama `validate.test.mjs`. Este PR apenas importa a suíte editorial nesse ponto de entrada, sem criar nem modificar workflows. A evidência válida é o resultado do GitHub Actions no SHA deste PR; execução local não é tratada como prova.
