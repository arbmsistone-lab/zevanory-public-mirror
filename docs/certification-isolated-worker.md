# ZEVANORY | Worker isolado de certificação

## Provisão Free já concluída pelo Orquestrador 01

- Nome de Worker: `zevanory-certification`.
- KV exclusivo: `ZEVANORY_CERTIFICATION_SANDBOX` — `48afe69de2ff4014b89acb553780ef35`.
- D1 exclusivo: `zevanory-certification-only` — `7ff006f3-1daf-44c5-9494-aabab600608e` (UUID **com hífens**).
- IDs acima já são os padrões do gerador. As vars GitHub `CERTIFICATION_KV_ID` e `CERTIFICATION_D1_ID` são **somente overrides**; reutilização de produção é recusada.
- O Worker tem entrada restrita, sem rota comercial, sem cron, sem service binding de produção, e somente `CERTIFICATION_PILOT_ENV=sandbox`, `MERCADOPAGO_ENV=sandbox`, `SALE_GLOBALLY_ENABLED=false`.

## Executar somente depois de autorização específica do Orquestrador

`certification-isolated-deploy.yml` exige `workflow_dispatch` na branch exata `gh-pages`, `expected_sha` completo, `sandbox-financial-approved`, primeiro attempt e quota Free. **Nenhum deploy por push ou por merge.**

A URL `https://zevanory-certification.<subdomínio-da-conta>.workers.dev` é extraída da **saída real do Wrangler**, registrada sem secretos no artefato `certification-origin-<SHA>`. A variável `CERTIFICATION_SANDBOX_URL` permite apenas override idêntico ao URL registrado; nenhuma URL da loja é aceita. O ensaio `mercadopago-combo-sandbox.yml` encontra o último deploy com `conclusion=success`, SHA exato e o artefato verificado, usando só `GITHUB_TOKEN` com `actions:read`. **Não depende de o dono descobrir o subdomínio.**

`CERTIFICATION_OPERATOR_TOKEN` é gerado com `openssl rand -hex 32` no próprio job e gravado somente no Worker isolado. Não é secret GitHub nem requer ação do dono.

Resend: uma única chave **Full access** consegue enviar e consultar recebimentos; a mesma chave `CERTIFICATION_RESEND_API_KEY` é inserida pelo deploy em ambos os nomes de runtime. **Full access não é restrição por domínio**: para isolamento real, gerar essa chave numa **conta Resend separada, de teste**, nunca na conta comercial. Uma chave somente `Sending access` não serve para consultar recebimentos. Não é necessário `CERTIFICATION_RESEND_RECEIVING_API_KEY` no GitHub.

## Apenas dois novos secrets do dono

No environment `sandbox-financial-approved` do GitHub:

1. `CERTIFICATION_DATABASE_URL`: string PostgreSQL de **banco novo, vazio, com esquema de certificação e sem dados de clientes**, não copiar URL/banco/branch de produção. D1 não substitui a dependência PostgreSQL da implementação canônica. Preferir base `certification` e credenciais dedicadas de menor privilégio.
2. `CERTIFICATION_RESEND_API_KEY`: chave **Full access** de uma conta Resend de teste isolada. Em Resend dessa conta: **API Keys → Create API Key → nome ZEVANORY Certification → Full access → Create**, copiar a chave uma vez. No GitHub: **Settings → Environments → sandbox-financial-approved → Environment secrets → Add secret**, com o nome exato.

Os demais secrets de teste existentes (`MERCADOPAGO_TEST_*`, `CERTIFICATION_E2E_TOKEN`, `SANDBOX_INBOX_READ_TOKEN`, `SANDBOX_IDENTITY_MANIFEST`) permanecem exclusivos do ambiente protegido. Não alterar os de produção.

## Provas e bloqueios

O Worker retorna 503 se faltar qualquer pré-condição e o ensaio exige `certification_worker_source_sha` igual ao `expected_sha` antes de consultar a API Mercado Pago. O webhook permitido é apenas o de testes assinado. Nenhuma operação financeira real, alteração de secrets da produção, pedido, reembolso, migração ou abertura de vendas é autorizada por este PR.

**Limitação operacional explícita:** o código canônico exige PostgreSQL e rotas de fulfillment; KV/D1 separados e URL HTTPS não comprovam, sozinhos, um checkout ponta a ponta. O Orquestrador precisa certificar o esquema e o fluxo sandbox antes de autorizar qualquer ensaio financeiro.
