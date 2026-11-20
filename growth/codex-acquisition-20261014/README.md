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

## Verificação dos números e universos

| Número citado | Período e indicador | Universo correto | Limite de interpretação |
|---|---|---|---|
| 74% usaram WhatsApp ou Telegram | TIC Empresas 2024, presença online | Empresas formais brasileiras com 10 ou mais pessoas ocupadas | Não representa MEI ou empresa com menos de 10 pessoas; agrega as duas plataformas |
| 84% venderam por mensagens | TIC Empresas 2024, E2C | Empresas de 10 a 49 pessoas ocupadas que venderam pela Internet nos 12 meses anteriores | O canal agrega WhatsApp, Skype e chat do Facebook; não mede conversão |
| 13% usaram IA | TIC Empresas 2024, H9 | Empresas formais com 10 ou mais pessoas ocupadas; pergunta coletada entre empresas com especialista/área de TI e resultado apresentado para o total | Não deve ser extrapolado para MEI; a edição 2025 registra 17%, mas o snapshot deste plano permanece 2024 |
| 12,8 milhões de empresas usaram Pix | Relatório de Gestão do Pix 2023–2025 | Pessoas jurídicas que haviam enviado ou recebido ao menos um Pix ao final do período | Não identifica porte nem prova demanda pelo produto |
| Quase 80 bilhões de transações Pix | Ano de 2025 | Total de transações Pix informado pelo Banco Central | Não corresponde apenas a pagamentos empresariais |

Indicadores diretos: [E2C — canais de venda online](https://cetic.br/pt/tics/pesquisa/2024/empresas/E2C/expandido/), [H9 — uso de IA](https://cetic.br/pt/tics/pesquisa/2024/empresas/H9/), [metodologia e população-alvo](https://www.cetic.br/pt/arquivos/pesquisa/2024/empresas/) e [atualização TIC Empresas 2025](https://www.cetic.br/pt/noticia/uso-de-inteligencia-artificial-por-empresas-brasileiras-avanca-e-atinge-17-aponta-pesquisa-do-cetic-br/).

## Avaliação dos cinco produtos

| Produto | Evidência de dor | Pressão competitiva | Papel recomendado |
|---|---|---|---|
| Vendas na Prática | Forte para venda via mensagens | Conteúdo gratuito abundante | Capturar intenção específica de orçamento, cobrança e follow-up; reaproveitar #806 |
| Lucro & Caixa | Forte para rotina de entradas/saídas e Pix | Sebrae oferece curso e ferramenta gratuitos | Priorizar calculadoras e rotina prática como porta de entrada |
| IA na Prática | Adoção ainda inicial e aplicações claras | Cursos gratuitos do Sebrae | Focar execução por ramo, revisão humana e segurança |
| Combo IA + Vendas | Interseção coerente entre IA e WhatsApp | Precisa provar utilidade, não receita | Usar como próxima etapa após conteúdo específico, não como tema genérico |
| Negócio Completo | Dor integrada plausível, intenção menos específica | Maior complexidade de mensagem | Tratar como consolidação para audiência já engajada |

Nenhum potencial de receita foi estimado. A ordem operacional está em `opportunities.json`, com rubrica reproduzível de 0 a 12. **Pix e WhatsApp empataram em 12 pontos.** Pix aparece primeiro exclusivamente porque o desempate técnico ordena o identificador em ordem lexicográfica; isso não demonstra procura, conversão ou potencial comercial superior. Os dois são hipóteses equivalentes para um teste controlado.

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
