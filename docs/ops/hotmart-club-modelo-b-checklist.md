# Hotmart Club, modelo B: checklist do proprietário (RASCUNHO)

Base: Sol ORDEM 313 (modelo B aprovado). Data: 28/10/2026 (America/Sao_Paulo). Estado: **VENDAS FECHADAS**.

Este documento não tem credenciais. Hottok, chaves e senhas ficam só no painel da Hotmart e nos segredos do Worker, colados pelo proprietário.

Escopo: os 5 kits (IA na Prática, Vendas na Prática, Lucro & Caixa, Combo IA + Vendas e Negócio Completo). O Conteúdo Pronto continua como está; o único item dele aqui é a correção da descrição na Hotmart (passo 9).

Regra do modelo B:
- **Dia 1:** aulas, manuais e guias online; planilhas (XLSX), modelos (DOCX) e arquivos de texto para baixar.
- **Dia 8:** PDFs e o pacote completo (.zip), pela liberação programada nativa do Club.
- Sem marca d'água por comprador. O aviso de licença é genérico e não é DRM.

Fontes no repositório:
- textos: `data/politica-unica.json` → `entrega_club`;
- produtos, IDs, links de checkout, regra do dia 8 e lista de arquivos por kit: `data/hotmart-kits.json`;
- código: `worker/hotmart-kits.mjs`.

Faça tudo primeiro em **um** produto (IA na Prática), rode os gates 1 a 4 e só então replique nos outros.

---

## 0. Formato de entrega dos produtos atuais (fazer antes de tudo)

Fato lido no painel em 28/10: o produto **8704733 (IA na Prática)** está como entrega por **ARQUIVO** ("Conteúdo do produto: upload ZIP/RAR/EXE, máx. 250 MB", com o zip v1.1). Os outros 4 kits provavelmente estão iguais. A tela inicial também mostra uma Área de Membros com 3 produtos, entre eles "ZEVANORY IA na Prática – Program".

- [ ] Em cada um dos 5 produtos, anote o formato de entrega atual e tire um print.
- [ ] **Verifique se o formato pode ser trocado para "Área de membros (Hotmart Club)" mantendo o MESMO ID de produto.** Anote o que a tela permite. Não troque ainda.
- [ ] **Se a troca no mesmo ID for possível:** troque só depois dos passos 1 a 5. Os links de checkout (`F107979716H`, `Y107979937I`, `L107979973K`, `H107979990T`, `U107980005X`) e os códigos de oferta continuam valendo; confira cada um.
- [ ] **Se for preciso criar produtos novos** (ou usar o "ZEVANORY IA na Prática – Program" já existente):
  - anote para cada kit o novo ID de produto, o código do checkout (`pay.hotmart.com/<código>?off=<oferta>`) e o preço;
  - mande os dados ao Claude. A troca é feita só em `data/hotmart-kits.json` (campos `hotmart_product_ids` e `checkout`), num PR; nada fica fixo no código;
  - para valer antes de um deploy, os IDs também podem ser informados na variável do Worker `HOTMART_KIT_PRODUCT_IDS` (formato `id=SKU,id=SKU`; não é segredo).
  - **Impacto de IDs novos:**
    - #954 e #959 (preço canônico e links: `scripts/hotmart_price_compare.py`, `hotmart-identity-audit.yml`);
    - inventário de links do P18;
    - links de afiliados já divulgados;
    - a página `/hotmart/<produto>`.
  - Desative o produto antigo só depois de migrar quem já comprou, se houver alguém.
- [ ] O mesmo ID também não pode estar listado em `HOTMART_SERVICE_PRODUCT_IDS` (Conteúdo Pronto, hoje 8704905).

## 1. Área de membros (uma vez)

- [ ] Abra a área de membros da ZEVANORY e anote o subdomínio.
- [ ] Ligue o e-mail de acesso, para que o comprador receba o login logo após a aprovação.
- [ ] Desligue comentários públicos ou modere-os. Comentários não podem expor dados pessoais.
- [ ] Na tela de liberação programada, **leia e fotografe as opções**: unidade (dias ou horas), ponto de partida (data da compra ou da aprovação), se vale por módulo ou por página, e o fuso. Mande o print; ele alimenta o gate 3.
- [ ] Na tela de anexos de página, leia e fotografe os tipos aceitos (.xlsx, .docx, .pdf, .zip) e o tamanho máximo. Mande o print.

## 2. Estrutura por kit (uma turma por produto)

Use em todos os kits a mesma estrutura de módulos:

| Módulo | Liberação | Conteúdo |
|---|---|---|
| 0 "Comece aqui" | imediata | Página "Como funciona seu acesso": o texto `entrega_club.faq_resposta`, o aviso de licença, como pedir arrependimento (Hotmart > Minhas compras ou suporte@zevanory.api.br) e o suporte |
| 1 "Aulas" | imediata | Uma página por aula, com texto e imagens online (manual v1.2 convertido). **Sem PDF anexado** |
| 2 "Planilhas e modelos" | imediata | Uma página por arquivo, com o XLSX ou DOCX original anexado e a instrução "baixe e use no Excel, LibreOffice ou Google Planilhas (Arquivo > Importar)". **Nenhum link de planilha compartilhada** |
| 3 "PDFs e pacote completo (dia 8)" | programada: **não antes de 8 dias** após a aprovação | Os PDFs e o pacote completo (.zip) anexados |

O aviso de licença vai no topo das páginas dos módulos 2 e 3 (ver o passo 6):

> Material licenciado para uso individual do comprador. É proibida sua revenda ou redistribuição não autorizada, respeitados os direitos previstos em lei.

Arquivos por kit (a lista exata, com SHA-256, está em `data/hotmart-kits.json` → `catalogo_contingencia`):

| Kit | Módulo 2 (dia 1) | Módulo 3 (dia 8) |
|---|---|---|
| IA na Prática | Planilha e Planilha Exemplo (XLSX); Manual, Guia Rápido e Comandos (DOCX); Comandos, COMECE_AQUI e CHANGELOG (TXT) | Manual, Guia Rápido, Comandos, COMECE_AQUI e CHANGELOG (PDF); `ZEVANORY_IA_na_Pratica_v1.2.zip` |
| Vendas na Prática | Planilha e Planilha Exemplo (XLSX); Manual, Guia Rápido, Mensagens e Conteúdos (DOCX); Mensagens, Conteúdos, COMECE_AQUI e CHANGELOG (TXT) | Os 6 PDFs; `ZEVANORY_Vendas_na_Pratica_v1.2.zip` |
| Lucro & Caixa | Planilha e Planilha Exemplo Salão (XLSX); Manual, Guia Rápido, Checklist Semanal e Comandos IA (DOCX); TXT correspondentes | Os 6 PDFs; `ZEVANORY_Lucro_e_Caixa_v1.2.zip` |
| Combo IA + Vendas | Os arquivos do dia 1 do IA e do Vendas, em duas pastas, mais LEIA_PRIMEIRO e CHANGELOG (TXT) | Os PDFs dos dois kits, LEIA_PRIMEIRO e CHANGELOG (PDF); `ZEVANORY_Combo_IA_e_Vendas_v1.2.zip` |
| Negócio Completo | Os arquivos do dia 1 dos três kits, mais o Plano de 30 dias (DOCX) e o Painel de Decisão Integrada (XLSX) | Todos os PDFs, incluindo o Plano de 30 dias; `ZEVANORY_Negocio_Completo_v1.2.zip` |

Mais três cuidados:
- O Lucro & Caixa e o Negócio Completo dependem dos builds v1.2 finais. Os arquivos do Club e do catálogo têm de ser os do build final; quando ele sair, regenere o catálogo com `python3 -I scripts/kits/build_club_catalog.py --dist <pasta dist>`.
- Depois de subir, baixe cada XLSX e DOCX **pelo Club** e confira que o SHA-256 é igual ao do catálogo (gate 2).
- Se o Club permitir, desligue o download do conteúdo das páginas do módulo 1 (aulas online).

## 3. Liberação programada (módulo 3)

- [ ] Configure o módulo 3 para liberar **8 dias após a aprovação do pagamento**. Se a tela contar dias civis em vez de 24 horas, ou usar a data da compra em vez da aprovação, anote e avise antes de vender.
- [ ] Regra do Worker na contingência:
  - aprovação + 192 horas, no mesmo horário de Brasília da aprovação (`data/hotmart-kits.json` → `liberacao_dia8`);
  - **o Club não pode liberar antes disso**;
  - se o gate 3 mostrar que o Club libera depois, o número do Worker sobe para o do Club.
- [ ] Gate 3: faça compras de teste às 00:05, 12:00 e 23:55 (horário de Brasília) e registre, com print e hora, quando o módulo 3 abre.

## 4. Reembolso

- [ ] Prazo de garantia do produto na Hotmart: no mínimo **7 dias**. Recomendação a confirmar com o Sol: um prazo maior, porque os PDFs chegam no dia 8 e os Termos dizem que, se as datas forem diferentes, vale a mais recente (ver a pergunta Q2 no PR).
- [ ] **Todo pedido de reembolso legítimo dentro do prazo é aprovado** pelo painel do produtor, mesmo com as aulas acessadas ou os arquivos baixados. Nunca recuse por consumo de conteúdo. Os Termos de Compra da Hotmart (3.2) permitem a recusa; a ZEVANORY não a usa.
- [ ] Pedidos que chegarem por suporte@ ou por zevanory.api.br/pedir-reembolso: estorne na Hotmart e registre no atendimento.
- [ ] Gate 4: faça uma compra e um reembolso de teste e meça em quanto tempo o Club tira o acesso. Se não tirar sozinho, remova o aluno à mão, com prazo combinado com o Sol.

## 5. Postback (webhook) e segredos

- [ ] O postback vai para a mesma URL do Conteúdo Pronto, `https://zevanory.api.br/api/webhooks/hotmart`, com o mesmo hottok, para os eventos:
  - compra aprovada, completa, reembolsada, chargeback, cancelada e reembolso solicitado (protesto);
  - no novo produto, se houver.
- [ ] Segredo do Worker, criado pelo proprietário e opcional: `KITS_PRIVACY_SECRET` (32 ou mais caracteres aleatórios). Sem ele, o Worker usa o `LEAD_PRIVACY_SECRET` existente. **Uma vez em uso, não troque**, porque a busca das compras depende dele.
- [ ] A contingência e a ingestão gravam no PostgreSQL de produção (tabelas `hotmart_kit_*`, criadas sozinhas no primeiro uso). Sem banco, o webhook do kit responde 503 e a Hotmart reenvia.

## 6. Aviso de licença nos arquivos

- Os PDFs v1.2 auditados **não trazem aviso de licença de uso**. A única "licença" neles é a das fontes, na pasta Licencas_de_fontes. Conferido nos 50 PDFs dos 5 pacotes v1.2 de `dist/`.
- **Decisão proposta:** não reconstruir os PDFs auditados. O aviso vai:
  - nas páginas do Club (módulos 0, 2 e 3);
  - no `LEIA_PRIMEIRO` / `00_COMECE_AQUI` do próximo build que já for acontecer (Lucro & Caixa e Negócio Completo finais), sem rebuild extra.
- O aviso não é DRM e não identifica o comprador.

## 7. Textos para colar na Hotmart

- [ ] **Descrição do produto e página de checkout:** `entrega_club.resumo_entrega` + `entrega_club.restricoes` (de `data/politica-unica.json`).
- [ ] **Mensagem de boas-vindas** (e-mail da área de membros ou mensagem pós-compra):
  - assunto: `entrega_club.email_boas_vindas_assunto`;
  - corpo: `entrega_club.email_boas_vindas`, com `{produto}` trocado pelo nome do kit, e `{rule_7d}` e `{refund_channels}` preenchidos como em `worker/politica-unica.mjs` (`ENTREGA_CLUB`).
- [ ] Não escreva em nenhum lugar "baixar todo o material", "download imediato" ou "link de 72 horas" para as compras Hotmart.

## 8. Contingência (Club fora do ar)

O serviço é desligado por padrão; só o operador liga, com motivo, por até 72 horas.

1. **Ligar:** `POST /api/admin/kits/contingencia/estado` com `{"enabled": true, "hours": 4, "operator": "<nome>", "reason": "<motivo>"}` (credencial de operador no cabeçalho Authorization; nunca neste documento).
2. **Link para uma compra:** `POST /api/admin/kits/contingencia/link` com o código da transação Hotmart, o e-mail informado pelo cliente, o operador e o motivo. O Worker:
   - confere o estado sincronizado (se a leitura falhar, não emite nada);
   - confere que o e-mail é o do comprador;
   - calcula os arquivos liberados (os do dia 8 só depois das 192 horas);
   - manda o link, que vale 2 horas por padrão e no máximo 24, **só ao e-mail do comprador**. O operador nunca vê o link.
3. **Revogar:** `POST /api/admin/kits/contingencia/revogar`. Reembolso, chargeback e cancelamento revogam sozinhos.
4. **Desligar:** a mesma rota do passo 1, com `{"enabled": false, ...}`.

Arquivos no KV: os arquivos do build final ficam em `zevanory/club-b/v1.2/<SKU>/<caminho>`, com o SHA-256 conferido a cada download.
- O upload só é feito com autorização do proprietário.
- Sem os arquivos, o link abre e o download responde "indisponível".
- O ZIP antigo (`zevanory/v1.1/*`) **nunca** é usado para comprador Hotmart.

Compra sem registro (postback perdido): nenhum link é emitido. Confira no painel da Hotmart e peça o reenvio do postback, se a tela permitir (não verificado).

## 9. Correção do Conteúdo Pronto na Hotmart (só texto)

- [ ] A descrição do plano do Conteúdo Pronto na Hotmart está desatualizada ("4 mensagens de WhatsApp"). Troque pelo texto atual de `resumo_oferta.assinatura.caracteristicas` (`data/politica-unica.json`). Os roteiros são multicanal, para canais autorizados pelo cliente, e não citam WhatsApp.

## 10. Antes de vender

- [ ] Gates 1 a 7 do plano com PASS, incluindo cliente oculto e compreensão.
- [ ] Revisão jurídica e aprovação P23 das mudanças propostas no PR (frase D7962-5-3 e `sol_text`).
- [ ] Só com "LIBERAR VENDAS".
