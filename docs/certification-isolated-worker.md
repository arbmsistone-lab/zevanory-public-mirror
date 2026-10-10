# ZEVANORY | Worker de certificação isolado

## Contrato de isolamento
- **Worker próprio:** `zevanory-certification`, entrada `certification-worker.mjs`; importa **o mesmo** runtime canônico do SHA aprovado. Nenhuma cópia do checkout é mantida aqui.
- **Publicação:** somente após `workflow_dispatch`, SHA exato, ambiente protegido `sandbox-financial-approved`, orçamento Free, sem promoção automática e sem domínio da loja. A URL `zevanory-certification.<account>.workers.dev` expõe apenas rotas técnicas autenticadas, sem páginas de venda.
- **Configuração:** `CERTIFICATION_PILOT_ENV=sandbox`, `MERCADOPAGO_ENV=sandbox`, `SALE_GLOBALLY_ENABLED=false`. Produção permanece intocada. Falha de qualquer pré-condição retorna 503.
- **Dados:** KV e D1 `CERTIFICATION_KV_ID`/`CERTIFICATION_D1_ID` devem ser **novos e exclusivos** (Free), nunca os IDs de produção. D1 é reservado ao sandbox e não recebe clientes. O checkout canônico ainda depende de SQL PostgreSQL, portanto `CERTIFICATION_DATABASE_URL` precisa apontar para um banco **vazio e isolado**, com esquema de teste, nunca um branch com dados reais. D1 não substitui Postgres por mágica.
- **Segredos:** somente `MERCADOPAGO_TEST_*` e `CERTIFICATION_*`, mais `SANDBOX_INBOX_READ_TOKEN`; o Worker recusa bindings de produção. Segredos de envio/recebimento de email também devem pertencer exclusivamente ao sandbox.
- **Preflight financeiro:** `.github/workflows/mercadopago-combo-sandbox.yml` exige `CERTIFICATION_SANDBOX_URL` HTTPS do nome exato no workers.dev, SHA aprovado e a aprovação já existente. O script nega qualquer destino do domínio comercial `zevanory.api.br`.
- **Webhook:** exclusivamente `/api/webhooks?provider=mercadopago_test`; o handler canônico valida a assinatura de teste. Não habilitar outras rotas nem recebimento comercial.
- **Sem execuções automáticas de pagamentos:** este PR não dispara compra, reembolso, webhook nem muda interruptores. A infraestrutura e as contas de teste devem ser validadas antes de uma nova execução manual.
- **Custo:** somente recursos existentes no plano Workers Free; se KV, D1, Worker ou banco separado excederem a franquia gratuita, abortar em vez de fazer upgrade.

### Sequência operacional
1. Criar/verificar KV e D1 exclusivos na conta Cloudflare Free; inserir seus IDs nas vars GitHub `CERTIFICATION_KV_ID` e `CERTIFICATION_D1_ID`; registrar a URL workers.dev exata em `CERTIFICATION_SANDBOX_URL`.
2. Adicionar ao ambiente protegido os segredos necessários para o Worker isolado: `CERTIFICATION_DATABASE_URL`, `CERTIFICATION_OPERATOR_TOKEN`, `CERTIFICATION_RESEND_API_KEY`, `CERTIFICATION_RESEND_RECEIVING_API_KEY`, mais os atuais `CERTIFICATION_E2E_TOKEN`, `MERCADOPAGO_TEST_PUBLIC_KEY`, `MERCADOPAGO_TEST_ACCESS_TOKEN`, `MERCADOPAGO_TEST_WEBHOOK_SECRET`, `SANDBOX_INBOX_READ_TOKEN`. Jamais copiar `DATABASE_URL`, `MERCADOPAGO_ACCESS_TOKEN`, `OPERATOR_TOKEN` ou `RESEND_API_KEY` de produção.
3. Fazer deploy manual do SHA por `certification-isolated-deploy.yml`. Com readback autenticado `status` provando o contrato v2 e o desligamento global, o Orquestrador poderá disparar **novo** ensaio financeiro por aprovação, nunca reexecutar runs antigos.

Observação: a origem `workers.dev` é uma URL técnica alcançável e protegida por token; não é um domínio público de vendas. Isso é necessário para o runner do GitHub alcançá-la.
