# Rodada 2 F1 — PR B bloqueado: proteção contra evento oficial de teste

Base: `3cd47670b2c86a71696984ea9a40df349f1da585`.
DRAFT de bloqueio; não contém envio de e-mail, agendamento, alteração de webhook ou cron. Não deve ser mesclado.

## Bloqueio obrigatório

O requisito 6 exige que o teste oficial da Hotmart jamais dispare pós-venda, mesmo antes do merge do PR A. A evidência atual não fornece assinatura exclusiva do botão oficial. O hottok é o do próprio produtor também no teste, conforme https://developers.hotmart.com/docs/en/changelog . Não basta autenticar, reconhecer PURCHASE_APPROVED ou aceitar um produto do catálogo para comprovar venda real. Sem a mesma evidência sanitizada descrita no PR A, conectar o disparo pode enviar e-mails indevidos.

## Divergência de fonte

A base indicada contém SKU, slug, nome e preço em data/products.json, mas não os IDs Hotmart. Os cinco IDs aparecem em data/p18-commercial-allowlist.json: 8704733, 8704826, 8704851, 8704861 e 8704871. O arquivo registra que o vínculo checkout/ID requer conferência na Hotmart; esta rodada não o transforma em verificação realizada. Nenhum desses arquivos foi editado. A futura implementação deve cruzar a fonte de identidade existente com o catálogo, sem duplicar ou modificar preço e sem incluir Conteúdo Pronto.

## Contrato para a implementação após destravar

- Só PURCHASE_APPROVED real autenticado dos cinco kits agenda D+0, D+1 e D+5. D+0 aponta à área de compras Hotmart; sem anexo. D+1 contém um primeiro passo do kit. D+5 contém suporte@zevanory.api.br. Sem preço, oferta, depoimento, promessa de ganho, WhatsApp ou Telegram. Filtro forbidden e trava de vendas exigidos antes do envio.
- Resend: prioridade transacional 1 e orçamento compartilhado verificado, teto de três e-mails por pedido. Estado por zpc:posvenda:hotmart:<transaction>:<etapa>, no máximo duas tentativas, chave de idempotência, corpo estável e registro anterior à chamada. Resultado desconhecido não autoriza novo POST; reconciliação verificável deve conferir destinatário, assunto, janela e referência da etapa antes de confirmar envio. Nunca tratar um 409 como entrega comprovada. Uma chave KV sem exclusão mútua não prova segurança concorrente; escolher mecanismo compatível antes de ligar o consumidor.
- Reembolso/chargeback cancela etapas futuras, inclusive evento recebido antes de aprovação ou reexecução. Descadastro em um clique impede novos envios. Falha de leitura ou estrutura inválida bloqueia; recuperação reconsulta fontes comprovadas, nunca apaga marca de envio, reembolso ou descadastro para liberar uma repetição.
- Guardar somente e-mail e primeiro nome necessários, com expiração até 30 dias depois da última etapa; não renovar retenção em replay. Não colocar dados pessoais em log, URL ou snapshot público. Tokens de descadastro não devem conter o e-mail.
- Teste oficial nunca agenda nem envia; proteção depende da evidência do PR A, não de uma flag inventada.

## Mutantes obrigatórios

Reenvio de estado desconhecido; envio após reembolso; oferta/preço no conteúdo; e-mail em log; mais de três envios por pedido; disparo por evento oficial de teste. Acrescentar cobertura de falhas KV, recuperação, concorrência, retenção, descadastro, limite de tentativas e prioridade/orçamento. Manifesto ordenado e suíte completa exigidos antes de implementar a entrega.

## Proposta de privacidade, sem alterar o caminho reservado

Texto para revisão do proprietário: “Após uma compra aprovada na Hotmart, poderemos usar seu e-mail e primeiro nome para enviar até três mensagens de acompanhamento transacional: acesso ao produto, orientação inicial e suporte de uso. Esses dados serão mantidos por até 30 dias após a última etapa prevista. Você poderá interromper esse acompanhamento por um link em cada mensagem. Este acompanhamento não inclui ofertas ou campanhas de marketing.” A aplicabilidade jurídica e a integração com a política vigente permanecem sujeitas à revisão do proprietário; esta proposta não altera a política publicada.

Nenhum caminho reservado tocado. Nenhuma regra funcional implementada ou certificada. Sem merge, rótulo, dispatch, reativação ou deploy. PRs existentes intocados.
