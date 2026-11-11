# Shorts padrão v2 — rodada 2 do PR #1028

Implementação para reauditoria; não é aprovação para publicar. Base auditada: `3a6fa5c8afabcae4d9c47afc18d0f286689446bb`. Mesmo ramo `feat/shorts-padrao-v2`. Especificação: [codex-shorts-v2-rodada2](https://docs.google.com/document/d/1W0aP-i-80um_oqbIA29DNEDMmt3DZiwp1_ZV2AZVVwA/edit).

Não houve merge, rótulo, dispatch, deploy, acesso a segredo ou reabilitação. `ops/executor.json` permanece intacto; a falha T1 não será contornada. Comparação de voz, confirmação do nível gratuito e aprovação do vídeo continuam falsas.

## NC01 — gravações humanas e provas de licença

As oito senoides procedurais e `generate-music.py` foram removidos. Há oito gravações de compositores identificados, cortadas em 36 segundos (a partir de 8 s), normalizadas e codificadas em OGG Vorbis. Total abaixo de 6.000.000 bytes, medido pelo teste de mídia.

| Tema | Faixas | Fonte |
|---|---|---|
| IA | Arpent; Hear What They Say — Kevin MacLeod | FreePD, categoria Electronic |
| Vendas | Advertime — Rafael Krux; Funshine — Kevin MacLeod | FreePD, categoria Upbeat |
| Finanças | From Page to Practice — Bryan Teoh; Inspiration — Rafael Krux | FreePD, categoria Upbeat; trechos suaves propostos para locução |
| Dicas | Study and Relax — Kevin MacLeod; Blue Skies — HoliznaCC0 | FreePD e coleção Happy Lo-Fi do autor no OpenGameArt |

`data/musica-licencas.json` registra URL do áudio, página original de licença, trecho literal, autor, título, SHA-256 do download original e do OGG entregue, início/duração do corte, clima e BPM estimado. As páginas arquivadas do FreePD identificam cada faixa e declaram **Creative Commons 0** na mesma página; o manifesto usa uma âncora de texto para a faixa. Blue Skies é a prévia pública da coleção Happy Lo-Fi, cuja página declara CC0. Evidências e SHA-256 das páginas consultadas: `docs/f1/evidencias/shorts-v2-rodada2/licencas.json`.

Não foram usados Pixabay, YouTube, música de IA ou download dependente de conta. Os arquivos são anteriores a esta implementação; Blue Skies tem data 2022-05-15 no áudio original. O crédito acompanha a descrição do upload e a prévia. `import-music.py` permite conferir o download pelo hash e reproduzir o corte, sem substituir silenciosamente hashes aprovados. O serial do contêiner OGG pode variar entre codificações.

A classificação de clima é uma proposta de curadoria, não uma audição certificada. BPM é uma estimativa por autocorrelação; não foi inventado como metadado do compositor. CC0 documenta o direito de uso; não certifica ausência de reivindicação automática falsa. Não foi comprovada inscrição legítima dessas gravações em Content ID. A reauditoria deve ouvir a trilha no vídeo antes de liberar este item editorialmente.

## NC02 — conteúdo do episódio e histórico estrito

Não existe mais um roteiro inteiro por tema musical. No slot principal `dica`, `data/shorts-episodios-v2.json` contém 40 episódios específicos, ligados ao **theme_id e à dica exata** do calendário. Cada episódio tem pergunta sobre a tarefa, quatro ações concretas e resultado sem promessa de ganho. Há também sete episódios para as calculadoras. Não são permutações de conectivos: o passo da receita da padaria difere do controle de validade, que difere do atendimento do pet shop. Dica sem passos correspondentes é bloqueada; não há resumo truncado nem preenchimento genérico.

No slot `oferta`, o construtor usa produto, nicho, ângulo e variante do episódio registrado no plano, a dica da tela e documentos próprios daquele nicho. O kit é resolvido pela SKU real, na allowlist existente, com UTMs `youtube/shorts/<tema>`. Cada frase tem até 12 palavras; o CTA permanece “Kit completo no link da descrição”.

A prova percorre **30 dias reais de dica e oferta: 60 roteiros distintos**, comparando todas as frases com o histórico dos demais. O plano não promete gerar conteúdo novo indefinidamente: quando o calendário não tiver uma lição correspondente, ou voltar a uma lição repetida, bloqueia e exige conteúdo novo.

Antes da síntese, `scriptHistory()` lê os últimos 60 dias dos três slots. `sha256(speech)` igual reprova em 60 dias; mais de 40% das frases iguais reprova em 30 dias. Impressões ficam em `zpc:shorts:v2:roteiro:<dia>:<slot>` e recibos `zpc:shorts:v2:roteiro:receipt:<dia>:<slot>`, com TTL de 65 dias. Estado corrupto só é recuperado de recibo legível e consistente. Ausência é aceita apenas quando projeção e recibo estão realmente ausentes. Prévia não reserva nem apaga histórico. Repetição idêntica do mesmo slot permite somente retentativa idempotente; não permite reusar outro dia ou slot.

## NC03 — QC obtido dos artefatos

O render grava `-legendas.ass` e `-filter.txt`. `inspect-captions.py` lê os Dialogues, posição, alinhamento, tamanho e largura medida pela fonte Inter usada no render. Texto e tempos do ASS são confrontados com o alinhamento; não se injeta `aligned:true`.

`visualMetrics()` lê início, duração e tamanho do gancho no filtro executado. Confere os textos ativos antes de 2 s e a máscara que oculta o logotipo já embutido no template nesse intervalo. O gancho fica do frame zero ao final da primeira frase, com 96 px.

As trocas são detectadas **no MP4 final** por `select='gt(scene,0.12)',showinfo`, e os intervalos incluem as bordas inicial e final. Não vêm da conta usada para desenhar. As métricas e os instantes detectados ficam em `-visual.json` e no QC. Render com legenda em y=1800, cenas de 5 s ou gancho de 58 px é reprovado pelos artefatos gerados. Os mutantes realmente alteram `render.mjs`.

O ensaio usa sinal de voz sintético local e alinhamento conhecido. Não comprova a naturalidade do Gemini nem substitui o teste posterior do alinhador real com fala humana sintética.

## NC04 — visual da marca

Template `assets/brand/export/short.png`, Inter ExtraBold, zoom suave, barra de progresso, gancho grande e cartão final com o kit. Cada passo tem número e detalhes do conteúdo do episódio; o trecho exibido acompanha os tempos das palavras alinhadas. A máscara do texto antigo ocupa a área necessária, sem deixar resíduos nas laterais após o zoom.

A fonte Inter foi obtida de `https://github.com/rsms/inter/blob/master/docs/font-files/InterVariable.ttf`, instanciada em peso 800/opsz 32 e registrada como Inter ExtraBold. Licença OFL em `assets/fonts/OFL-Inter.txt`. Não depende da fonte instalada no host.

`-contato.png` reúne um frame de cada cena detectada. O artefato `short-preview` inclui MP4, QC, visual medido, ASS, filtro, roteiro, alinhamento, faixa e licença.

## NC05 — modelo aprovado e matriz de oito amostras

`data/shorts-padrao-v2.json` preserva `gemini-3.8-flash-tts` como referência. Produção usa somente o modelo e a voz fixos; resultado sem modelo declarado ou com modelo divergente reprova. Não existe fallback automático entre modelos.

O protocolo 3.8 usa Interactions, conforme o v1; o 2.5 usa generateContent. Testes com transporte falso verificam payload, identidade e uma única tentativa. Não são provas de disponibilidade comercial ou de nível gratuito.

`compare-voices.mjs` prepara Achird, Puck, Kore e Leda nos dois modelos, com a mesma frase, oito WAVs e métricas por identidade. O teste verifica a matriz com substitutos locais; **nenhum WAV Gemini real foi gerado nesta rodada**. O comando exige confirmação do nível gratuito e credencial de execução autorizada. Não escolhe uma vencedora, não publica e não modifica as aprovações. A geração real e a escuta ficam pendentes para a etapa autorizada seguinte.

## NC06 — classificação explícita

SKU conhecida tem precedência. Identificadores e nomes usam fronteiras de palavra; `farmacia` e `diaria` não contêm uma palavra `ia`. Ambiguidade leva a `dicas` e ao aviso `theme_ambiguous_using_dicas` no plano. O teste cobre prioridade de produto, acentos, substring e ambiguidade; o mutante remove a fronteira.

## Reprodução e evidências

```bash
node --test tests/shorts-v2.test.mjs tests/shorts-v2-round2.test.mjs
node --test tests/media/shorts-v2-media.test.mjs
node --test tests/*.test.mjs
```

O job de mídia roda em Linux, sem ambiente de produção nem segredos, com FFmpeg e Pillow. A suíte portátil não exige esses programas. Não executar `compare-voices.mjs`, workflow de publicação ou importação de música como parte dos testes.

Resultados e limites desta rodada em `docs/f1/evidencias/shorts-v2-rodada2/resultado.md`. O SHA definitivo e o estado observado do CI serão registrados na descrição do PR após o push.
