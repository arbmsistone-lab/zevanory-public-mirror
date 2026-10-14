# C1–C3 — Inteligência de aquisição (Codex)

Data da evidência: 2026-10-14. Mercado: Brasil.

## Limite desta entrega

Este módulo é deliberadamente separado da operação: não altera checkout, pagamentos, Worker de vendas, banco, secrets, deploy canônico, publicação ou dados pessoais. Ele transforma evidências públicas em um backlog auditável. Os números citados são sinais de demanda, não estimativas de receita nem volume de busca.

## Inventário e reaproveitamento

Já existem no repositório:

- `worker/acquisition-engine.mjs`: calendário para os cinco produtos, UTMs, limites de promessa, deduplicação e publicação por canal.
- `worker/funnel.mjs`: medição agregada por página, origem e campanha, sem cookie e sem IP bruto armazenado.
- `/material-gratuito`, `/ia-por-ramo` e `/ferramentas`: entradas gratuitas para qualificar tráfego antes da oferta.
- `.github/workflows/acquisition-excellence.yml`: testes do motor existente com mocks e cobertura.

Esta entrega não recria esses componentes. Ela acrescenta somente a camada anterior: seleção transparente de oportunidades baseada em evidências.

## Conflitos evitados

Os PRs ativos do Claude ocupam as zonas que poderiam conflitar:

- #798: blog, links de funil e workflow central.
- #806: três novas páginas evergreen, sitemap, build e Worker de vendas.
- #808 e #809: atribuição e submissão de lead.
- #812: filtros de navegador do Telegram no funil e vendas.

Por isso esta branch só toca `growth/codex-acquisition-20261014/` e um workflow de CI exclusivo, sem permissão de escrita e sem deploy.

## Demanda nacional fundamentada

1. **Venda conversacional é prioridade.** A TIC Empresas 2024 registra WhatsApp/Telegram em 74% das empresas; entre pequenas empresas que venderam online, 84% usaram mensagens como canal. Isso favorece intenção em atendimento, orçamento, cobrança e follow-up.
2. **IA aplicada tem espaço, mas conteúdo genérico enfrenta forte concorrência gratuita.** A mesma pesquisa registra 13% das empresas usando IA; o Sebrae oferece formação gratuita e aponta WhatsApp, conteúdo e respostas a dúvidas como aplicações acessíveis. A diferenciação recomendada é aplicação por ramo, modelos revisáveis e ligação com tarefas reais.
3. **Caixa é amplo e operacional.** O Banco Central registra 12,8 milhões de empresas usuárias do Pix ao fim de 2025. O Sebrae mantém cursos e ferramenta gratuita de fluxo de caixa, sinal simultâneo de demanda e concorrência. A ZEVANORY deve atrair por calculadoras, exemplos e rotina diária antes de apresentar produto pago.
4. **A oferta gratuita existente reduz atrito de entrada.** Calculadoras, guias por ramo e checklist permitem aprender com visitas e intenções agregadas sem anúncio pago nem promessa financeira.

Fontes:

- [TIC Empresas 2024 — Cetic.br/CGI.br](https://www.cetic.br/pt/publicacao/pesquisa-sobre-o-uso-das-tecnologias-de-informacao-e-comunicacao-nas-empresas-brasileiras-tic-empresas-2024/)
- [Estudo de Visão de Futuro em IA 2025 — Sebrae](https://ia.sebrae.com.br/estudo/2025/index.html)
- [Relatório de Gestão do Pix 2023–2025 — Banco Central](https://www.bcb.gov.br/detalhenoticia/21227/noticia)
- [Como controlar o fluxo de caixa — Sebrae](https://sebrae.com.br/sites/PortalSebrae/cursosonline/como-controlar-o-fluxo-de-caixa%2C45b0b8a6a28bb610VgnVCM1000004c00210aRCRD)
- [IA na prática para pequenos negócios — Sebrae](https://pa.loja.sebrae.com.br/ia-na-pratica-para-pequenos-negocios-1-372000104947)

## Avaliação dos cinco produtos

| Produto | Evidência de dor | Pressão competitiva | Papel recomendado |
|---|---|---|---|
| Vendas na Prática | Forte para venda via mensagens | Conteúdo gratuito abundante | Capturar intenção específica de orçamento, cobrança e follow-up; reaproveitar #806 |
| Lucro & Caixa | Forte para rotina de entradas/saídas e Pix | Sebrae oferece curso e ferramenta gratuitos | Priorizar calculadoras e rotina prática como porta de entrada |
| IA na Prática | Adoção ainda inicial e aplicações claras | Cursos gratuitos do Sebrae | Focar execução por ramo, revisão humana e segurança |
| Combo IA + Vendas | Interseção coerente entre IA e WhatsApp | Precisa provar utilidade, não receita | Usar como próxima etapa após conteúdo específico, não como tema genérico |
| Negócio Completo | Dor integrada plausível, intenção menos específica | Maior complexidade de mensagem | Tratar como consolidação para audiência já engajada |

Nenhum potencial de receita foi estimado. A ordem operacional está em `opportunities.json`, com rubrica reproduzível de 0 a 12.

## Arquitetura mínima

```text
fontes públicas + inventário do repositório
                  |
                  v
         opportunities.json
                  |
                  v
       validate.mjs + testes
                  |
                  v
    CI somente leitura (sem secrets)
                  |
                  v
 backlog auditado -> aprovação humana -> motor existente
```

O validador falha se houver fonte ausente, produto desconhecido, UTM incompatível com o funil, promessa financeira proibida, campo com aparência de segredo ou ordem de prioridade divergente do score.

## Como verificar

```bash
node --test growth/codex-acquisition-20261014/validate.test.mjs
node growth/codex-acquisition-20261014/validate.mjs growth/codex-acquisition-20261014/opportunities.json
```

O workflow `codex-acquisition-intelligence.yml` executa os dois comandos no GitHub Actions, sem rede, secrets, cache, artefatos ou permissão de escrita.
