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

## Auditoria das alterações posteriores à integração

- `4bb9c14e`: mantido. A normalização LF antes do fingerprint elimina diferenças Windows/Linux tanto no nome quanto nos bytes do ativo; a regeneração precisa continuar produzindo zero byte de diferença no mesmo checkout.
- `4fd065dd` — P24 `offer_receives`: mantido e justificado pela consolidação do layout, que removeu o bloco duplicado `offer-side`. As cinco regiões que restaram continuam obrigatórias e o mapa cobre as promessas visíveis. O ajuste do mutante M25 apenas acompanha literalmente “venda e acompanhamento”.
- `4fd065dd` — P23 L1.4: mantido porque a antiga expectativa de “CEP a confirmar” deixou de ser verdadeira; o gate agora relata a lacuna verificável das páginas-fonte fora de `sales-public`.
- `ea90522d`: reversões não declaradas encontradas e corrigidas: escopo do `/pedir-reembolso` no aviso do chat; seção e âncora `#assinatura-hotmart`; regras correspondentes em Termos; canal Hotmart no FAQ; remoção de “que são a base para vender mais”; endereço legado do 404; regex partido de `pedir-reembolso`. A varredura dos arquivos alterados pelos cinco PRs não encontrou outra perda contratual após a regeneração e os gates de cópia.

O gate jurídico agora exige `data/politica-unica.json.legal_review` com `status=APPROVED`, responsável e data. O candidato permanece deliberadamente em `PENDING`; nenhuma aprovação foi inventada pelo executor.

- A272-01: a matriz local usa o aceite literal do proprietário e reprova overflow horizontal, clipping, painel rolável e fundo inalcançável.
- A272-02: lista de espera comercial e material gratuito têm tabelas, consentimentos e rotinas separados. Abrir vendas não libera ofertas para contatos do material gratuito; os passos comerciais antigos são aposentados. Relação comercial futura exige consentimento separado, auditável e cancelável e não foi implementada.
- A272-03: procedimento por provedor está separado, mas permanece **REVISÃO JURÍDICA PENDENTE**.
- #941: aposentadoria e 308 são cobertos pelos testes; o endereço público é `suporte@zevanory.api.br`; o recebimento do endereço antigo é preservado fora da superfície publicada.
- #943: a integração PostgreSQL simula queda depois do envio pelo provedor falso e antes da exclusão; apó novo Worker, a mesma chave de idempotência não produz segunda entrega.
- O candidato não incorpora #945; a sobreposição está em `docs/release/release-2-x-945.md`.

## Efeito de um merge futuro

Nenhum deploy foi executado por este trabalho. Se o proprietário autorizar e efetuar merge em `gh-pages`, os caminhos alterados acionam os fluxos automáticos existentes:

1. `.github/workflows/central-production-deploy.yml` — publica o Worker central; usa o Environment `producao-critica`.
2. `.github/workflows/zevanory-sales-public-release.yml` — publica o Worker/site de vendas; usa o Environment `producao-critica`.

Essa consequência exige a autorização própria de merge e as proteções do Environment; este candidato não concede nem antecipa essa autorização.

## Reauditoria rodada 2 (Claude, sobre `486c339f`) e ORDEM 294

Base atualizada: merge de `gh-pages` `b7671272` (#947) na branch, sem conflito. Nada foi publicado; vendas fechadas.

- **N-H1 (chat, K030).** O `6ada78f9` voltou a nomear a Hotmart em `customer_wording.subscription_refund`, o que o validador do chat (`worker/site-chat.mjs`, `CHECKOUT_RE`) reprova. A resposta voltou ao texto de #942 sem nomear o processador e ganhou só o que a lei pede ("de imediato e monetariamente atualizados"; "a ZEVANORY comunica imediatamente essa plataforma ou a administradora do cartão"). O §3 do Decreto 7.962 com o nome da Hotmart fica nas páginas jurídicas. O aviso `optional` do chat voltou ao texto literal de #942. Contrato separado: `guardReply` decide só o texto; a intenção de atendimento já classificada (reembolso, cancelamento, arrependimento, entrega, pagamento…) continua em `category`/`intent` e no escalonamento, mesmo quando o texto é bloqueado (`tests/cta-contract-closed.test.mjs` C1–C2).
- **N-M2.** `hasCheckoutCta` voltou a reconhecer a palavra "Hotmart" (inclusive "Assine agora na Hotmart") e o mutante M-S3 voltou ao original. Nenhuma guarda tropeçou em texto legítimo depois disso. Prova de que nenhum CTA comercial volta com `SALE_GLOBALLY_ENABLED=false`: C3–C5 (detector, guardas de e-mail/legenda/chat/P09 ligadas a ele, checkout fechado com interruptor fechado/ilegível, páginas e `/hotmart/` sem link de compra com CORE fechado ou em falha).
- **N-M1 e L-a/L-b.** Termos §3 voltou a ter a frase de #942 sobre as páginas `/hotmart/`, com a asserção original restaurada. Termos §2 e o Resumo voltaram a citar o Conteúdo Pronto (#939); "checkout" voltou a "página de pagamento" em Produtos de terceiros (Termos e Reembolso) e nos passos do `/conteudo-pronto`; texto LGPD de #939 restaurado; "de imediato" no art. 49 (texto único, Termos, Reembolso, assinatura e Estorno Hotmart).
- **N-H2 (matriz no check obrigatório).** Causa reproduzida localmente em ambiente CI-like (Playwright 1.55, axe 4.10.3, só DejaVu/Liberation): o gate media logo após `load`. (a) Em `/ia-por-ramo`, que não tem script, `load` chegava antes das fontes web (`document.fonts.status=loading`; a troca de fonte acontecia durante o axe). (b) Nas páginas de produto a 320/360 px, o `scrollTo` disparava a barra de compra (transição de 0,2 s) e o axe pegava `target-size` "partially obscured"; resultado diferente entre os temas claro/escuro com a mesma geometria. Correções: o gate espera fontes e o fim das animações antes de medir; mede sobreposição de CTA (novo critério, reprova); registra navegador/versões/fontes/viewport e salva capturas das reprovações; o CI publica o artefato. A medição estável revelou um defeito real, corrigido na página: a 320 px a barra de compra tem 157 px e cobria o botão rolado até ela (folga de rolagem de 128 px); `product.css` passa a 184 px em telas ≤ 420 px e `buy-bar.js` iguala a folga à altura real da barra.
- **M5 (lista de espera).** Aviso congelado em `zevanory_waitlist_notices` com estados explícitos: `attempting` (em curso), `unconfirmed` (resultado desconhecido), `confirmed` (entregue/409), `expired` (fora da janela de 23 h; nunca reenviado), e exclusão `requested` → `confirmed`. Nova tentativa só é a mesma mensagem com a mesma chave dentro da janela do provedor; produto confirmado depois vira aviso próprio; falha na exclusão nunca gera segundo envio; saída da pessoa impede qualquer nova tentativa. Provas: PostgreSQL real P10–P12 (e a ferramenta `m5-test.mjs` do auditor), modelo em memória `tests/waitlist-m5.test.mjs` na suíte, mutantes MW16/MW17.
- **KV.** Lista de espera: o marcador "há dados" é gravado antes do registro (KV em falha = 503, nada guardado) e, com a lista desligada, KV ilegível faz a retenção rodar (só apaga). Webhook Hotmart do Conteúdo Pronto: o marcador de evento processado passou a ser gravado por último e o reprocessamento é idempotente por transação (ciclo e e-mail de briefing não se repetem). Interruptor de vendas e chat: KV em falha = fechado/desligado (C4–C5, M7).
- **M1 (revisão jurídica na publicação).** `scripts/p23/legal_review.py`: impressão digital do texto jurídico (páginas `/termos` e `/reembolso` das duas superfícies e textos de consumo de `data/politica-unica.json`, incluindo `legal_document_version`). A aprovação exige revisor cadastrado pelo proprietário em `data/p23/legal-reviewers.json` (vazio hoje), nome igual, data, `reviewed_sha256` igual ao texto atual, `reviewed_commit`, `document_version` e o registro auditável `docs/legal/reviews/<sha256>.json`. O P23 usa a mesma regra; `zevanory-sales-public-release.yml` e `central-production-deploy.yml` rodam `--publish-gate` no job de deploy antes de qualquer chamada à Cloudflare. Texto idêntico ao publicado em `b7671272` (`data/p23/legal-published-baseline.json`) passa sem revisão; texto novo sem aprovação válida bloqueia o deploy (fail-closed).

### Efeito do portão M1 depois do merge

Este candidato muda o texto jurídico; portanto, enquanto `legal_review` estiver `PENDING`, os dois jobs de deploy param no passo "Legal review gate" com `LEGAL_PUBLISH_GATE=BLOCKED`, antes de tocar a produção. Nada que está no ar é retirado: produção segue com os Workers e o texto de `b7671272`. Qualquer outro deploy desses dois fluxos também fica parado até a aprovação, porque o texto no repositório já não é o publicado. Para publicar: o proprietário cadastra o revisor, o revisor aprova a impressão digital atual com o registro em `docs/legal/reviews/`, e depois da publicação a linha de base é atualizada para o mesmo valor.
