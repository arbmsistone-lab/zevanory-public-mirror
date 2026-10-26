# Release 2 — registro da integração

Base imutável: `gh-pages@a098d8802a184df02b362d46f08fb6c81b7382f9`.

## Origem e merge commits

| Ordem | PR | Head de origem | Merge commit no candidato |
|---|---:|---|---|
| 1 | #941 | `c4bfd4bf2d6f0362fd5b605b02cfdda655ad8f51` | `5761786` |
| 2 | #942 | `4c661bcc024d88937ecf27588b616c551ee76ebf` | `ccec36a` |
| 3 | #939 | `067d2f8e392058d18cbd3a9860b2d75347fc8ce0` | `57ae59e` |
| 4 | #940 | `1aa61af73f082c41169448ed80b8f5475f92ccaf` | `98c36cb` |
| 5 | #943 | `cefb58766c735e61f05db4bbba5de7b9f9b24b68` | `21b902c` |

## Conflitos resolvidos

Cada item abaixo identifica o arquivo ou a lista exata de arquivos, o lado usado e o motivo.

### #939 sobre #941 + #942

- `.github/workflows/portfolio-p03-exact.yml`, `.github/workflows/product-pages-premerge.yml`: lado #939; contém os hashes e o gate de cópia correspondentes à nova superfície.
- `data/politica-unica.json`: lado já integrado de #942; preserva a separação factual Mercado Pago × Hotmart. Depois recebeu apenas as correções editoriais de #939 (`contados` e `prazo`, sem mudar o procedimento).
- `data/site-chat-policy.json`: lado #939; o fingerprint precisa acompanhar o catálogo novo.
- `scripts/ci/sales_promise_consistency.py`: lado #939; conserva o mutante regex que cobre todas as ocorrências de "Em breve".
- `combo-ia-vendas/index.html`, `negocio-completo/index.html`, `vendas-na-pratica/index.html`, `zevanory-sales/index.html`: lado #939. `reembolso/index.html` e `termos/index.html`: regra multicanal de #942 com as correções editoriais de #939. `conteudo-pronto/index.html`: contrato v2 mais recente da base, porque o lado #939 reintroduzia WhatsApp e removia a idempotência multicanal; `solucoes/index.html` e `kit-afiliado/index.html` preservam o layout/cópia de #939, mas mantêm os trechos contratuais v2 da base para o Conteúdo Pronto.
- `evidence/zees16/coverage/combo-ia-vendas.json`, `evidence/zees16/coverage/negocio-completo.json`, `evidence/zees16/coverage/vendas-na-pratica.json`: lado #939; evidência correspondente à cópia nova.
- `sales-public/combo-ia-vendas.html`, `sales-public/conteudo-pronto.html`, `sales-public/index.html`, `sales-public/kit-afiliado.html`, `sales-public/negocio-completo.html`, `sales-public/reembolso.html`, `sales-public/solucoes.html`, `sales-public/termos.html`, `sales-public/vendas-na-pratica.html`, `sales-public/zevanory-sales.html`: nenhum lado foi mantido como artefato final; todos foram regenerados por `scripts/build_sales_public.py` a partir das fontes integradas.

### #940 sobre o resultado anterior

- `ia-por-ramo/index.html`: estrutura/layout de #940 com a correção editorial de #939 (`Açaiteria`).
- `sales-public/assets/product.7c0e9a61b6.css`, `sales-public/assets/product.8bf871a289.css`, `sales-public/assets/product.de0025e05a.css`: conflito rename/rename descartado como artefato derivado; o gerador publicou somente o hash atual.
- Os seguintes conflitos em artefatos derivados receberam a estrutura de #940 durante o merge e foram depois integralmente regenerados: `sales-public/404.html`, `sales-public/arbm-contador-saloes.html`, `sales-public/calculadora-cmv.html`, `sales-public/calculadora-fluxo-de-caixa.html`, `sales-public/calculadora-margem-de-lucro.html`, `sales-public/calculadora-ponto-de-equilibrio.html`, `sales-public/calculadora-preco-de-venda.html`, `sales-public/calculadora-preco-hora-servico.html`, `sales-public/calculadora-taxa-maquininha.html`, `sales-public/checklist-15-minutos.html`, `sales-public/combo-ia-vendas.html`, `sales-public/como-cobrar-cliente-pelo-whatsapp.html`, `sales-public/como-mandar-orcamento-pelo-whatsapp.html`, `sales-public/conteudo-pronto.html`, `sales-public/ferramentas.html`, `sales-public/ia-na-pratica.html`, `sales-public/ia-para-academia.html`, `sales-public/ia-para-acaiteria.html`, `sales-public/ia-para-advocacia.html`, `sales-public/ia-para-agencia-de-viagens.html`, `sales-public/ia-para-arquitetura-e-design-de-interiores.html`, `sales-public/ia-para-assistencia-tecnica-de-celular.html`, `sales-public/ia-para-autoescola.html`, `sales-public/ia-para-barbearia.html`, `sales-public/ia-para-clinica-e-consultorio.html`, `sales-public/ia-para-clinica-odontologica.html`, `sales-public/ia-para-confeitaria.html`, `sales-public/ia-para-contabilidade.html`, `sales-public/ia-para-deposito-de-bebidas.html`, `sales-public/ia-para-distribuidora-de-gas-e-agua.html`, `sales-public/ia-para-eletricista-e-encanador.html`, `sales-public/ia-para-escola-de-idiomas.html`, `sales-public/ia-para-estetica.html`, `sales-public/ia-para-farmacia.html`, `sales-public/ia-para-fisioterapia.html`, `sales-public/ia-para-floricultura.html`, `sales-public/ia-para-fotografo.html`, `sales-public/ia-para-hamburgueria.html`, `sales-public/ia-para-imobiliaria.html`, `sales-public/ia-para-lava-jato.html`, `sales-public/ia-para-loja-de-roupas.html`, `sales-public/ia-para-manicure.html`, `sales-public/ia-para-marmitaria.html`, `sales-public/ia-para-materiais-de-construcao.html`, `sales-public/ia-para-mercadinho.html`, `sales-public/ia-para-nutricionista.html`, `sales-public/ia-para-oficina-mecanica.html`, `sales-public/ia-para-otica.html`, `sales-public/ia-para-padaria.html`, `sales-public/ia-para-papelaria.html`, `sales-public/ia-para-pet-shop.html`, `sales-public/ia-para-pizzaria.html`, `sales-public/ia-para-pousada.html`, `sales-public/ia-para-psicologo.html`, `sales-public/ia-para-restaurante-e-lanchonete.html`, `sales-public/ia-para-salao-de-beleza.html`, `sales-public/ia-por-ramo.html`, `sales-public/index.html`, `sales-public/kit-afiliado.html`, `sales-public/lucro-e-caixa.html`, `sales-public/material-gratuito.html`, `sales-public/mensagem-para-cliente-que-sumiu.html`, `sales-public/negocio-completo.html`, `sales-public/quem-criou.html`, `sales-public/solucoes.html`, `sales-public/vendas-na-pratica.html`, `sales-public/zevanory-cfo.html`, `sales-public/zevanory-sales.html`.

### #943 sobre o resultado anterior

- `.github/workflows/trava-vendas-integracao-postgres.yml`: combina os dois lados; mantém o caminho fiscal P23 já presente e acrescenta todas as entradas da lista de espera, sua integração PostgreSQL e mutantes.

## Condições e limites

- A272-01: a matriz local usa o aceite literal do proprietário e reprova overflow horizontal, clipping, painel rolável e fundo inalcançável.
- A272-02: lista de espera e material gratuito têm tabelas, consentimentos e rotinas separados. A integração PostgreSQL prova que abrir vendas não usa contatos do material gratuito.
- A272-03: procedimento por provedor está separado, mas permanece **REVISÃO JURÍDICA PENDENTE**.
- #941: aposentadoria e 308 são cobertos pelos testes; o endereço público é `suporte@zevanory.api.br`; o recebimento do endereço antigo é preservado fora da superfície publicada.
- #943: a integração PostgreSQL simula queda depois do envio pelo provedor falso e antes da exclusão; apó novo Worker, a mesma chave de idempotência não produz segunda entrega.
- O candidato não incorpora #945; a sobreposição está em `docs/release/release-2-x-945.md`.

## Efeito de um merge futuro

Nenhum deploy foi executado por este trabalho. Se o proprietário autorizar e efetuar merge em `gh-pages`, os caminhos alterados acionam os fluxos automáticos existentes:

1. `.github/workflows/central-production-deploy.yml` — publica o Worker central; usa o Environment `producao-critica`.
2. `.github/workflows/zevanory-sales-public-release.yml` — publica o Worker/site de vendas; usa o Environment `producao-critica`.

Essa consequência exige a autorização própria de merge e as proteções do Environment; este candidato não concede nem antecipa essa autorização.
