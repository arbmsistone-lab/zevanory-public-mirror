# ZEVANORY — Produtos digitais v2.0

Data: 2026-09-14.
Escopo: cinco produtos digitais complementares. ARBM SIST e ARBM ONE permaneceram em standby e não foram alterados por esta frente.

## Padrão de qualidade aplicado
- conteúdo especializado por domínio, sem módulo-template genérico;
- cinco módulos por produto-base com exercícios e critérios de domínio;
- ferramentas práticas para plano de ação, experimentos, decisões e scorecard;
- checklist de implementação e referências de aprofundamento;
- entrada visual offline e responsiva `INICIAR-AQUI.html`, sem scripts ou dependências externas;
- bundles carregam integralmente os produtos-base e plano integrado;
- nomes internos ASCII-safe, ZIP determinístico, manifesto versionado, SHA-256 e caminhos seguros;
- venda continua fail-closed enquanto o gate global de vendas estiver bloqueado.

## Produtos
- ZEV-IA-011 — ZEVANORY IA na Prática — versão 2.0 — tabela R$ 197 — piloto R$ 147.
- ZEV-VEN-011 — ZEVANORY Vendas na Prática — versão 2.0 — tabela R$ 197 — piloto R$ 147.
- ZEV-LCX-011 — ZEVANORY Lucro & Caixa — versão 2.0 — tabela R$ 247 — piloto R$ 197.
- ZEV-CMB-011 — ZEVANORY Combo IA + Vendas — versão 2.0 — tabela R$ 297 — piloto R$ 247.
- ZEV-NGC-011 — ZEVANORY Negócio Completo — versão 2.0 — tabela R$ 397 — piloto R$ 347.

## Artefatos canônicos
- ZEVANORY_IA_na_Pratica_v2.0.zip — SHA-256 `67293badc24f0ebbbabfa8912e2149873ee3a22dc1c60ea90cade381a5f4dd19`.
- ZEVANORY_Vendas_na_Pratica_v2.0.zip — SHA-256 `640740406382ec4fd92ff14039707eac830d2b685ffc45b98b8af606b9467a31`.
- ZEVANORY_Lucro_e_Caixa_v2.0.zip — SHA-256 `46cdbbdc201050c895c79e542dedb95d5e934171132136cbf177556c6daaefa5`.
- ZEVANORY_Combo_IA_e_Vendas_v2.0.zip — SHA-256 `3e1ebf1f615e6876e20d1b3b42d89c20aeb0357d3546bce1af395b31211a8d35`.
- ZEVANORY_Negocio_Completo_v2.0.zip — SHA-256 `484c4ed7848f8f3d57b739a4c5dab8fce77901d0fbc638c87d1c76e233fa342a`.

## Evidência de fechamento do conteúdo
- gate dedicado de conteúdo v2: PASS;
- 6 termos técnicos obrigatórios por produto-base confirmados pelo auditor;
- leitor offline/responsivo obrigatório e sem dependência externa: PASS;
- reprodução determinística dos 5 artefatos: PASS, hashes estáveis após rebuild;
- teste focado catálogo/artefatos: PASS;
- suíte integral: 773/773 PASS no último ciclo completo;
- identidade: `IDENTITY_GUARD_PASS`.

## Limite de certificação
O catálogo distingue a qualidade do conteúdo da certificação comercial integral: `content_quality_certified=true` e `quality_certified=false`. Isso é intencional e fail-closed. Nenhum desses cinco produtos resolve para checkout enquanto `sellable=false`.

## Regra de liberação
A excelência do artefato de conteúdo não abre vendas, checkout, mídia paga ou fulfillment. A certificação integral do produto exige ainda os gates globais aplicáveis da ZEVANORY e prova da jornada comercial/entrega em produção, sem alterar o bloqueio global nesta frente.
