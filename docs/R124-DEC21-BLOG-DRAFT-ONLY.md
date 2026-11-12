> **SUBSTITUÍDA (10/11/2026).** A DEC-21 foi substituída de forma expressa pelo **Plano Mestre ZEVANORY v1.2, seção 9**
> (aprovado pelo proprietário em 10/11/2026, com PASS do GPT-6; Fase 1, item 3). O blog volta a publicar sozinho com
> gate de qualidade (`worker/blog-quality-gate.mjs`, chamado por `ensureDailyBlog` em `worker/multichannel-autonomy.mjs`):
> - no máximo 3 artigos por semana ISO (segunda, quarta e sexta), com contador idempotente `zpc:blog:week:v1:<AAAA-Www>`;
> - o gate rejeita conteúdo sem fonte verificável quando há dado factual, duplicado (título igual ou similaridade de
>   trigramas >= 0,5), com promessa de ganho ou termo do filtro `forbidden`, sem utilidade (menos de 400 palavras, menos
>   de 4 seções ou sem roteiro/passos/exemplo), sem compliance 100 e score >= 85, com CTA inválido ou que fere a trava
>   de vendas;
> - CTA: `/hotmart/<kit>` com UTM no modo Hotmart; material gratuito com UTM nos demais casos; nunca `/comprar/`;
> - resultado do dia (ok com URL, ou rejeitado com motivos) em `zpc:blog:status:v1:<dia>`, no máximo 1 gravação por dia,
>   no armazenamento operacional existente (KV), sem D1 e sem o binding DIARIO (NC-01);
> - a pausa criativa continua parando a publicação; a revisão passa a ser por amostragem.
>
> Os testes que travavam o modo só-rascunho (`tests/r117-blog-owner-gate.test.mjs` e os contratos "DEC-21" de
> `tests/multichannel-autonomy.test.mjs` e `tests/nc015-cp-no-public-links.test.mjs`) foram substituídos por
> `tests/blog-autopublicacao.test.mjs` e pelos contratos "Plano Mestre §9" equivalentes. O texto abaixo é histórico.

# R124 | DEC-21 somente rascunhos, sem publicação
Proprietário: decisão por consenso com Claude e GPT-6. PR #972 permanece Draft, nenhum merge ou deploy.
Este patch preserva os cinco testes legados, convertendo seus contratos: 60 dias e dias sucessivos geram exclusivamente `zpc:blog:draft:v1:<dia>`; nenhum artigo público, índice, marcador diário ou chamada IndexNow. Índices históricos são imutáveis. Para preservar a regressão dos links SEO e da DEC-04, testes de conteúdo publicado criam EXPLICITAMENTE registros históricos artificiais no KV falso depois de comprovar que o gerador não os criou.
`BLOG_AUTOPUBLISH=true` e até um marcador de aprovação falso não criam permissão para publicação. Fase 2 de aprovação, trava atômica e publicação ficam congeladas. Os testes antigos não foram excluídos nem retirados do manifesto.
