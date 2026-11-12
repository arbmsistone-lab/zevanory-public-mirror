# C5 — Receita recorrente nacional

Data de corte: 14/10/2026  
Mercado: Brasil  
Base canônica: `881933399228abf15820f743bfe1bd1f6df28128`

## Veredito

A primeira validação deve ser do **Conteúdo Pronto setorial**, não de uma assinatura nova.

Ele já aparece no catálogo por R$ 197/mês e já possui escopo e entrega declarados. Isso reduz trabalho novo, mas **não prova** assinantes, disposição de pagamento, margem ou retenção. A recomendação é validar interesse sem cobrança e medir três entregas internas antes de qualquer teste comercial.

## Evidência nacional

- A TIC Empresas 2024 registra forte uso de mensagens e redes sociais. Entre pequenas empresas que venderam online, 84% usaram mensagens. A pesquisa cobre empresas formais com 10 ou mais pessoas ocupadas; não representa automaticamente MEIs.
- O Sebrae cita 76% dos MEIs usando redes sociais e mensagens para aumentar vendas. É sinal de comportamento, não prova de compra de assinatura.
- A rotina de caixa é recorrente e relevante para MEIs segundo o Sebrae, mas orientação gratuita e software financeiro completo competem com qualquer oferta leve.
- A adoção de IA cresceu entre empresas pequenas de 10 a 49 pessoas, mas permanece minoritária. Interesse em IA não equivale a interesse em um produto específico.
- O Mapa de Empresas evidencia um mercado empresarial amplo; tamanho total não é mercado endereçável.

## Concorrência e preço observado

| Categoria | Referência observada | Preço público observado | Comparabilidade |
|---|---|---:|---|
| Gestão de redes | mLabs mensal, 1 perfil | R$ 49,90/mês | software; não cria pacote setorial completo |
| Serviço social media | estudo publicado pela mLabs | R$ 500–3.000/mês | serviço mais amplo; fonte de fornecedor e escopo diferente |
| CRM para WhatsApp | RD Station CRM Basic | R$ 73/usuário/mês | CRM completo, com plano gratuito concorrente |
| Atendimento com API | RD Conversas Basic | R$ 989/mês anual | plataforma de maior porte e custos variáveis |
| Gestão financeira | Nibo Light mensal | R$ 208/mês | SaaS financeiro completo |
| Gestão financeira | Granatum | R$ 396/mês | SaaS financeiro completo |

Os preços são retratos das páginas citadas na data de corte. Não demonstram disposição de pagamento pela ZEVANORY.

## Matriz comparativa

Escala de 1 a 5; pontuações são julgamento analítico reproduzível, não métricas comerciais.

| Posição | Oportunidade | Demanda | Frequência | Reuso | Economia de entrega | Retenção | Risco inverso | Total |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Conteúdo Pronto setorial | 5 | 5 | 5 | 4 | 4 | 3 | 26 |
| 2 | Rotina de follow-up para WhatsApp | 5 | 5 | 4 | 4 | 4 | 2 | 24 |
| 3 | Caixa em Dia | 4 | 5 | 4 | 3 | 4 | 2 | 22 |

## As três oportunidades

### 1. Conteúdo Pronto setorial — recomendado

Público: MEIs e pequenos negócios locais que vendem por WhatsApp e redes, mas não mantêm comunicação semanal.

Oferta: preservar o pacote existente — 12 posts, 4 mensagens de venda para WhatsApp e calendário de 30 dias — adaptado ao ramo. O cliente revisa e publica.

Preço: R$ 197/mês é o valor existente no catálogo e a hipótese inicial; não é disposição comprovada de pagamento.

Frequência: uso semanal e reposição mensal.

Retenção possível: economia de tempo e especificidade por ramo. Risco de cancelamento: material genérico, esforço de publicar, sazonalidade e alternativas gratuitas com IA.

Custo: não quantificado. A classificação baixa/moderada depende de três entregas internas medindo tempo de máquina, revisão humana, suporte e retrabalho.

### 2. Rotina de follow-up para WhatsApp

Público: dono que vende por mensagens e perde próximas ações.

Oferta hipotética: quadro semanal, prioridades e mensagens reutilizáveis. A primeira versão não envia mensagens, não armazena contatos e não usa a API do WhatsApp.

Preço hipotético: R$ 49/mês. O plano gratuito do RD CRM é concorrência direta; por isso, preço e retenção são especialmente incertos.

### 3. Caixa em Dia

Público: MEI que precisa de uma rotina curta antes de adotar um ERP financeiro.

Oferta hipotética: checklist semanal, fechamento mensal e orientação sobre totais inseridos pelo próprio usuário, sem conexão bancária nem execução financeira.

Preço hipotético: R$ 69/mês. Há forte necessidade recorrente, mas também materiais gratuitos e sistemas completos. Confiança, disciplina e privacidade elevam o risco de cancelamento.

## Teste de demanda recomendado, sem cobrança

Somente após autorização do proprietário:

1. preparar uma página de interesse ou protótipo não publicado com os entregáveis atuais e a hipótese de R$ 197/mês;
2. usar apenas tráfego orgânico já existente e qualificado;
3. medir contagens agregadas de exposição e clique de interesse;
4. não exigir dados pessoais no primeiro teste e não oferecer checkout;
5. definir o limiar de sucesso **antes** da exposição, sem ajustá-lo aos resultados;
6. encerrar em 200 exposições qualificadas ou 28 dias;
7. parar imediatamente se surgir cobrança, coleta obrigatória de dados, custo não mensurável ou falta de aprovação.

Nenhum teste foi iniciado por este PR.

## Custos e margem

Não existem evidências acessíveis de consumo de IA, tempo de revisão, suporte, retrabalho ou margem do Conteúdo Pronto. Inventar um custo em reais seria enganoso. O pacote define os fatores e exige três dry runs internos antes de qualquer conclusão econômica.

## Limites

- Nenhuma métrica comercial ou dado pessoal foi acessado.
- Nenhum preço foi apresentado como WTP comprovada.
- Nenhuma assinatura, oferta, mensagem, transação, página ou experimento foi criado.
- Nenhum Worker, checkout, pagamento, funil, produto ou workflow foi alterado.
- Os PRs #815, #816 e #818 não foram modificados.
- Implementação e publicação exigem auditoria separada e autorização do proprietário.

Arquivos verificáveis: `sources.json`, `opportunities.json`, `simulation-protocol.json`, `validate.mjs` e `validate.test.mjs`.


## Protocolo pré-registrado após auditoria

O arquivo `simulation-protocol.json` fecha as três lacunas apontadas pela auditoria sem iniciar execução:

- três pacotes fictícios: salão de beleza, lanchonete e loja de roupas;
- custos de geração, revisão, retrabalho, suporte e entrega começam obrigatoriamente como `null`;
- qualidade mínima de 85/100 por pacote, nenhuma dimensão abaixo de 3/5 e zero falha crítica;
- teto operacional hipotético de R$ 49,25 por entrega (25% do preço atual), revisão + retrabalho até 75 minutos e suporte estimado até 30 minutos/mês;
- qualquer custo desconhecido torna sustentabilidade **inconclusiva**, nunca zero;
- teste de interesse continua bloqueado até PASS das simulações e nova autorização.

Critérios pré-registrados do futuro teste agregado, sem cobrança:

- **sucesso:** 200 visualizações qualificadas e pelo menos 10 cliques “Tenho interesse por R$ 197/mês” (5%);
- **insucesso:** 200 visualizações e no máximo 5 cliques (2,5%);
- **inconclusivo:** 6–9 cliques, menos de 200 visualizações em 28 dias ou perda de medição.

Esses limiares são critérios gerenciais para decisão, não benchmarks de mercado. Clique de interesse não prova compra, renovação ou lucro.

O protocolo está apenas preparado. Nenhum conteúdo foi gerado, nenhuma simulação foi executada e nenhum teste foi publicado.
