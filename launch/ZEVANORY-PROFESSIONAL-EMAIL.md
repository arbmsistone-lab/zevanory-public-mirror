# ZEVANORY - E-mail profissional

Dominio: zevanory.api.br
Status: arquitetura pronta; caixa real depende de provedor e DNS autenticado.

## Enderecos oficiais
Principal: contato@zevanory.api.br
Suporte: suporte@zevanory.api.br
Vendas: vendas@zevanory.api.br
Financeiro: financeiro@zevanory.api.br

## Politica de remetente
From comercial: ZEVANORY <contato@zevanory.api.br>
Reply-To suporte: suporte@zevanory.api.br
Reply-To vendas: vendas@zevanory.api.br
Financeiro nunca envia marketing.

## Gates obrigatorios antes de ativar
MX publicado e validado.
SPF com politica alinhada ao provedor.
DKIM ativo e validado pelo provedor.
DMARC publicado inicialmente com monitoramento seguro.
TLS exigido no transporte quando suportado.
Provider API/SMTP armazenado somente como Secret.

## Fluxos preparados
Boas-vindas/lista de lancamento.
Confirmacao de interesse.
Checkout iniciado sem pagamento confirmado.
Pagamento confirmado e entrega segura.
Onboarding do ARBM SIST.
Suporte pos-venda.
Pedido de avaliacao somente apos uso real.