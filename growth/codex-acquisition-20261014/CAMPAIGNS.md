# C1–C3 — Experimentos orgânicos comparáveis

Status: **rascunho não publicado**. Esta entrega prepara duas campanhas e não publica, envia mensagens, compra mídia, altera produção ou acessa credenciais.

## Campanhas

| Campanha | Produto | Problema | Entrada gratuita |
|---|---|---|---|
| Fluxo de caixa diário e Pix | Lucro & Caixa | separar saldo, entradas Pix e contas numa rotina diária | `/calculadora-fluxo-de-caixa` + checklist de 15 minutos |
| Acompanhamento pelo WhatsApp | Vendas na Prática | organizar orçamento, retorno e cobrança sem spam | três guias existentes + checklist de 15 minutos |

As duas usam a mesma janela proposta de 14 dias, os mesmos cinco canais orgânicos e uma peça por canal. Não há previsão de receita, tráfego ou conversão.

## Reaproveitamento verificado

Na branch canônica já existem:

- calculadora gratuita de fluxo de caixa;
- checklist gratuito de 15 minutos;
- páginas de Lucro & Caixa e Vendas na Prática;
- guias `/mensagem-para-cliente-que-sumiu`, `/como-cobrar-cliente-pelo-whatsapp` e `/como-mandar-orcamento-pelo-whatsapp`;
- canais editoriais no motor existente: blog, Telegram e Bluesky;
- canais já configurados pelo proprietário: YouTube e TikTok;
- funil agregado em `worker/funnel.mjs`, com páginas, origem, campanha e sinais de intenção.

Nenhum desses arquivos foi alterado. Os materiais são referenciados, não duplicados.

## Limites de medição

O funil atual permite observar `clean.campaigns.<utm_campaign>` para visualizações rastreadas. Intenções como inscrição e checkout são agregadas por origem, não por campanha. A classificação brasileira também não é cruzada com campanha.

Por isso:

- campanha pode ser comparada por visitas atribuídas;
- intenção por campanha não pode ser alegada causalmente;
- baselines e metas permanecem `null` até existir observação limpa;
- as páginas de guia `como-*` e `mensagem-*` não são rastreadas individualmente no funil atual;
- qualquer ampliação do funil exige outro PR operacional e não faz parte desta entrega.

## Arquivos

- `campaigns.json`: públicos, proposta de valor, canais, UTMs, materiais, peças prontas para revisão e indicadores.
- `validate-campaigns.mjs`: validação fail-closed.
- `validate-campaigns.test.mjs`: testes positivos e adversariais.
- `validate.test.mjs`: importa a nova suíte para reaproveitar o CI somente leitura já existente no #813.

## Proteções

O validador bloqueia:

- publicação, mídia paga ou mensagens diretas;
- promessas de lucro, renda, faturamento, vendas ou conversão;
- baseline ou meta inventada;
- campo com aparência de segredo;
- destino não aprovado;
- UTM inválida ou duplicada;
- troca de produto;
- canais/janelas não comparáveis;
- conteúdo com similaridade de trigramas igual ou superior a 50%.

## Verificação

```bash
node --test growth/codex-acquisition-20261014/validate.test.mjs
node growth/codex-acquisition-20261014/validate-campaigns.mjs growth/codex-acquisition-20261014/campaigns.json
```

A branch foi criada sobre o SHA aprovado do #813. O PR novo deve usar o #813 como base, de modo que seu diff contenha exclusivamente `growth/**`. Isso preserva o isolamento do Marco A e não altera o workflow existente.
