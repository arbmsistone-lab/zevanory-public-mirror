# C1–C3 — Experimentos orgânicos comparáveis

Status: **propostas editoriais não publicadas e não prontas para distribuição**. Não há vídeos produzidos ou certificados. Esta entrega não publica, envia mensagens, compra mídia, altera produção ou acessa credenciais.

## Campanhas preservadas

| Campanha | Produto | Problema | Entrada |
|---|---|---|---|
| Fluxo de caixa diário e Pix | Lucro & Caixa | separar saldo, entradas Pix e contas numa rotina diária | calculadora gratuita |
| Acompanhamento pelo WhatsApp | Vendas na Prática | organizar orçamento, retorno e cobrança sem spam | três guias existentes |

As duas mantêm o mesmo desenho editorial: janela proposta de 14 dias, cinco canais orgânicos e uma proposta por canal. Isso não significa que seus resultados de tráfego sejam hoje comparáveis.

## Matriz de destinos reais

| ID | URL certificada esperada | Conteúdo conferido | Rastreado por `clean.campaigns` |
|---|---|---|---|
| `cashflow_calculator` | `https://vendas.zevanory.api.br/calculadora-fluxo-de-caixa` | Calculadora de fluxo de caixa | sim |
| `free_checklist` | `https://vendas.zevanory.api.br/material-gratuito` | Checklist de 15 minutos | sim |
| `whatsapp_reengagement_guide` | `https://vendas.zevanory.api.br/mensagem-para-cliente-que-sumiu` | Mensagem para cliente que sumiu | não |
| `whatsapp_collection_guide` | `https://vendas.zevanory.api.br/como-cobrar-cliente-pelo-whatsapp` | Como cobrar sem constranger | não |
| `whatsapp_quote_guide` | `https://vendas.zevanory.api.br/como-mandar-orcamento-pelo-whatsapp` | Como mandar orçamento | não |

A prova em nuvem mostrou que as cinco rotas retornam 404 no domínio principal e 200 sem redirecionamento no domínio de vendas. O domínio não é inferido por uma base comum. Cada destino possui URL absoluta, URL final esperada, marcador de conteúdo e estado de rastreamento. O teste em nuvem lê cada rota com redirecionamento habilitado e exige HTTP 200, `text/html`, URL final correta e marcador presente.

## Lacuna de medição

O funil existente rastreia `calculadora-*` e `material-gratuito`, mas não inclui as rotas `mensagem-*` ou `como-*`.

Consequências:

- campanha de caixa: cobertura de visitas 5/5 nos destinos propostos;
- campanha de WhatsApp: cobertura 0/5 nos destinos propostos;
- `clean.campaigns.c3_whatsapp_clientes` não pode ser usado como prova de visitas;
- nenhuma comparação de tráfego ou conversão entre as duas campanhas é autorizada;
- intenções continuam agregadas por origem, não por campanha;
- baselines e metas permanecem `null`.

Corrigir o funil exigiria outro PR operacional. Isso foi deliberadamente mantido fora desta rodada.

## Prontidão editorial

| Canal | Artefato existente | Estado real |
|---|---|---|
| SEO | brief de interligação/cluster | não produzido nem certificado |
| YouTube | roteiro resumido | vídeo não produzido nem certificado |
| TikTok | roteiro resumido | vídeo não produzido nem certificado |
| Telegram | texto em rascunho | não aprovado e não publicado |
| Bluesky | texto em rascunho | não aprovado e não publicado |

Todas as dez propostas carregam `ready_for_distribution: false`. “Roteiro” não é “vídeo” e “texto em rascunho” não é publicação autorizada.

## Proteções automáticas

O validador bloqueia:

- guia de vendas associado a domínio diferente de `vendas.zevanory.api.br`;
- rota, redirecionamento final, status, tipo de conteúdo ou marcador incorretos;
- declaração de medição para destino fora do funil;
- classificação editorial superior ao artefato realmente existente;
- publicação, mídia paga ou mensagens diretas;
- promessas de lucro, renda, faturamento, vendas ou conversão;
- baseline ou meta inventada;
- campo com aparência de segredo;
- conteúdo duplicado, UTM ou destino inválido e troca de produto.

## Verificação em nuvem

```bash
node --test growth/codex-acquisition-20261014/validate.test.mjs
node growth/codex-acquisition-20261014/validate-campaigns.mjs growth/codex-acquisition-20261014/campaigns.json
```

O PR permanece empilhado sobre o #813. Seu diff continua limitado a `growth/**`; nenhum workflow foi criado ou modificado.
