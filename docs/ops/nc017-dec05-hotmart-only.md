# ZEVANORY | DEC-05 | Primeira fase exclusivamente Hotmart
**Registro técnico de decisão delegada: GPT-6 APROVA, 03/11/2026.** Sujeita a veto ou confirmação posterior do proprietário.
**Status de execução:** CANDIDATA em branch isolada / PR #968 Draft. **NÃO AUTORIZA merge, publicação ou abertura de vendas**.

## Base verificável
- R59 (Claude) identificou dois fluxos incompatíveis: a Hotmart candidata controla PDFs e ZIP após 192 horas; o checkout próprio Mercado Pago libera ZIP por link de 72 horas após pagamento.
- DEC-01 v3 determina acesso online/planilhas imediatamente e PDFs/ZIP após 192 horas.
- DEC-04 restringe o lançamento inicial a cinco guias/kits e mantém assinatura Conteúdo Pronto indisponível.

## Voto e escopo
**Aprovo DEC-05:** Hotmart como único canal de **novos pedidos** na fase 1, por Pix à vista ou cartão; o Mercado Pago **não** poderá gerar novo pedido por nenhuma rota pública, serviço interno, piloto, variável de ambiente ou abertura da chave geral de vendas.

## Camadas obrigatórias no candidato
1. `worker/nc015-sales-scope.mjs`: `MP_PHASE1_CHECKOUT_ENABLED=false` em código. Alterar flag exige PR e autorização humana, não variável de ambiente.
2. `worker/cloudflare-worker.compat.mjs`: guarda em `isCheckoutRoute()` ANTES de chamar `evaluateCheckout`, pilotos ou handler do checkout; responde 503 `phase1_hotmart_only`. `checkout.internal` e rota direta devem convergir.
3. `worker/sales-public-worker.mjs`: POST `/comprar/<SKU>` responde 503; GET/HEAD com vendas abertas redireciona somente à rota `/hotmart/<slug>` que consulta `/api/sales/status`; com vendas fechadas continua sem checkout. Nunca consulta `checkout.internal` pelo fluxo bloqueado.
4. A guarda de criação **não** interrompe direitos de consumidores antigos, estornos, fiscalização interna ou reconciliação de pagamentos passados.
5. `/conteudo-pronto`, `/assinar/conteudo-pronto` e demais rotas da assinatura permanecem 404 e noindex.

## Matriz de garantias e oráculos
| ID | Condição | Oráculo necessário |
|---|---|---|
| D5-01 | Vendas fechadas, GET `/comprar` | Sem checkout nem link Hotmart ativo; resposta noindex/no-store |
| D5-02 | Vendas abertas, GET/HEAD `/comprar/<SKU>` | 302 apenas para `/hotmart/<slug>`; zero chamadas MP |
| D5-03 | POST público `/comprar/<SKU>` | 503 independentemente de user agent, vendas, rate limiter, env e cliente |
| D5-04 | POST central `/api/checkout/mercadopago` | 503 `phase1_hotmart_only` antes do handler/provider |
| D5-05 | POST via `https://checkout.internal/` | 503 idem, inclusive `x-certification-pilot-token` |
| D5-06 | Pagamentos e entregas existentes | Pós-venda/estorno e acesso preservados, com provas |
| D5-07 | `/hotmart/<slug>` | Texto coerente com Hotmart, Pix à vista/cartão, 192 h; nenhum Mercado Pago ou URL de reembolso exclusivo MP |
| D5-08 | CP | 404/noindex em vendas abertas e fechadas; sem checkout de assinatura |
| D5-09 | Regra de liberação | Nenhum link PDF/ZIP antes de 192h nem após reembolso |
| D5-10 | CI final | 8/8 kits + 4/4 escopo + 5/5 NC016 + 4/4 NC017, build reproduzível e suíte completa auditada |

## Limites
- O R59 documentou **94 falhas** totais na versão `b932f28`, vs referência histórica de **41 falhas CP**. Nenhuma contagem futura pode ser inferida de alterações de teste sem EXECUÇÃO no SHA final.
- Checks de código não comprovam preço/modalidade do checkout Hotmart real, estado do Club, arquivos privados ou site publicado.
- A aprovação jurídica de textos permanece pendente do #946/P23; NÃO se declara aprovação por esta decisão.
- **VENDAS FECHADAS**. Só reabrir com ordem literal do proprietário `LIBERAR VENDAS`, mais gates independentes de merge e deploy.
