# EG-0033 — No-Inventory Commerce Final

Status: candidata a fechamento estrutural.
Release: ZEVANORY-EG0033-FINAL.
Escopo: prontidão pré-comercial sem estoque; não autoriza vendas reais.

## Modelo aprovado
- Serviços próprios: somente digitais ou remotos.
- Produtos físicos: somente ofertas de terceiros por afiliação.
- Estoque próprio: proibido neste modelo.
- Receita afiliada: somente comissão confirmada pela rede/plataforma.
- GMV externo não é receita própria da ZEVANORY.

## Controles obrigatórios
- `SALE_GLOBALLY_ENABLED=false` por padrão.
- `PRE_SALE_GATES_APPROVED=false` por padrão.
- `CHECKOUT_ENABLED=false` por padrão.
- `FINANCIAL_EVENTS_ENABLED=false` por padrão.
- Ativação depende de identidade legal, suporte e políticas publicadas.
- Serviço próprio exige Asaas Production e credenciais válidas.
- Afiliado exige provedor, tracking validado e termos revisados.

## Infraestrutura
- Migration `007_no_inventory_commerce` adiciona `affiliate_commissions` e `service_fulfillment`.
- Checkout suporta apenas ambientes explícitos `sandbox` ou `production` e falha fechado nos demais.
- Páginas `/termos`, `/privacidade`, `/reembolso` e `/afiliados` são superfícies públicas obrigatórias.

## Veredito
APROVADO estruturalmente quando todos os gates automatizados estiverem PASS e o schema 007 estiver validado. Venda real permanece bloqueada até requisitos comerciais externos serem preenchidos.