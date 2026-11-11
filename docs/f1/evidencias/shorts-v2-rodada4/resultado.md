# PR #1028 — rodada 4b, NC11–14

Base: `e7381e9d55cb472602f65ce91c363969982d7d4d`. Mesmo ramo. Especificação: [codex-shorts-v2-rodada4b](https://docs.google.com/document/d/11o2IpYZz6hg7B1IJpuyEpF5EPfHdhwFSDWPFNtA7kCk/edit). Esta rodada não aprova publicação nem ativa a curadoria.

## Entrega e critérios

| NC | Correção | Teste | Mutante |
|---|---|---|---|
| 11 | round3 no manifesto com 15 testes; round4 com 32; ordem de bytes e soma exata | manifesto real, 14 testes do verificador e guarda de portabilidade | aceitar arquivo fora da lista |
| 12 | saída bruta removida; resumo limitado a contagens e testes dos Shorts; exceções do contato intactas | filtro de resumo + suíte real | aceitar saída bruta |
| 13 | HTML, MP4, contatos, ASS e JSON extensos fora do checkout; pacote portátil no Actions | destino externo, hashes, 2 áudios e 3 previews | aceitar destino dentro do repositório |
| 14 | perfil medido, descoberta, teto mensal, observação, métricas verificadas, veto e rotação | decisões do proprietário, vocais, licença, limite, retenção, veto e 180 escolhas | ignorar tags, licença, teto de 2, retirada por retenção ou veto |

Validação local: **1.591/1.591** testes portáteis; **9/9** provas de mídia; **32/32** testes desta rodada (incluídos nos 1.591); **8 mutantes novos detectados**. Verificador do manifesto **14/14**; guarda de portabilidade **3/3**; preços **12/12**; laboratório anterior de sales-lock **34/34** preservado; governança `NO_NEW_DEBT=true`, `FALSE_GREEN=0`.

Os logs brutos não são versionados. `resumo-testes.txt` contém apenas contagens e nomes de testes dos Shorts. O pacote `shorts-v2-review`, criado pelo job **Shorts v2 offline media checks**, contém as páginas `previews.html` e `musicas.html`, mídias relativas, licenças, hashes e simulação de 180 dias. É necessário baixar e extrair o artefato para abrir as páginas; não são páginas do site.

## Decisão musical vigente

Somente **Arpent** (`ia-1.ogg`, preferência IA) e **Funshine** (`vendas-2.ogg`, preferência vendas/finanças/dicas). As outras seis gravações e seus registros ativos foram removidos. A recusa de Hear What They Say permanece apenas no perfil, com motivo, data e vetor medido, porque é uma referência negativa exigida para aprender o gosto. Não foi inventada uma nova audição: são as escolhas explícitas do proprietário.

A ordem usa preferência de tema com alternativa aprovada de outro tema; nunca repete a última faixa. Em uma janela ímpar, o limite inteiro é `ceil(N/2)`, pois duas faixas não podem dividir um número ímpar exatamente ao meio. Há prova de 180 seleções alternadas (90/90), e de aumento de participação por peso quando houver três ou mais faixas. Com apenas duas, o teto e a alternância impedem aumentar a participação acima de metade.

Funshine tem uma brincadeira editorial contendo a palavra “Dark” na descrição original. Isso não revoga a aprovação explícita do proprietário para esse hash. A exceção é a decisão manual registrada; não foi removido o veto de estilos para novas candidatas. Um veto posterior em `recusadas` prevalece sempre.

## Perfil, descoberta e observação

`data/musica-perfil.json` registra decisões e medidas reais dos arquivos: BPM estimado, RMS, centroide espectral, LRA e modo/tonalidade estimados por croma. `audio-features.py` calcula DSP e roda **YAMNet** localmente por LiteRT 1.4.0. O modelo de 521 classes vem da distribuição oficial, fixado por SHA-256. As duas sementes foram medidas e remedidas; os resultados estão em `medidas-aprovadas.json`. O CI também remede as sementes com o mesmo modelo, sem API paga.

O detector é probabilístico: presença ou incerteza de vocal bloqueiam. “Ausente” exige evidência de música e baixa pontuação de categorias vocais na análise de todo o trecho. Não se afirma que um classificador elimina todo falso negativo. A verificação com fala real e a audição do proprietário continuam relevantes antes de liberar o fluxo.

`curadoria-musica.mjs` consulta FreePD primeiro e, se indisponível, as páginas originais arquivadas usadas na prova de licença. Só aceita hosts/prefixos explícitos; páginas sem declaração de CC0 ou sem linha individual da faixa não produzem candidatas. Downloads têm limite de tamanho e tempo; o decoder fica restrito ao protocolo de arquivo e formato MP3. Arquivo normalizado precisa cobrir 35–40 s e ter hashes do original e do corte. Não há catálogo alternativo pago, conta criada, música de IA deliberadamente aceita ou queda para licença desconhecida.

A nota usa distância às medidas aprovadas, penalidade por proximidade às recusadas e sinais positivos da descrição. Tags vetadas são bloqueadas antes da medição. O limiar mínimo configurado é 0,72; máximo de 12 candidatas medidas por execução e **2 promoções por mês**, incluindo reexecuções do mesmo mês. O orçamento dos áudios no repositório permanece em 6 MB. Sem candidatas elegíveis, a descoberta promove zero; não afrouxa a licença nem os vetos.

Promoções entram em `observacao`; cinco vídeos públicos distintos confirmados mudam para `ativa`. Identidade e hash impedem promoção duplicada. O perfil aprende também com uma recusa de uma linha, usando o vetor do registro existente. Um veto é aplicado na seleção, no aprendizado e no relatório, mesmo antes de outra busca.

## Desempenho e relatório

Retenção usa `averageViewPercentage` por vídeo, em **GET** ao YouTube Analytics. O token vem da ponte existente; nenhum escopo foi acrescentado ou testado com credencial nesta rodada. Se o acesso atual não autorizar Analytics, o relatório diz **sem dados**; isso não vira retenção zero nem altera peso. Este ponto depende da conexão real na futura ativação.

A publicação registra ID público do vídeo e arquivo da trilha em recibo próprio, separado da reserva de render. O marcador da trilha também acompanha a descrição. Uma retomada que reutiliza um vídeo usa a identificação recebida do provedor, e não credita a faixa do render descartado. Reuso sem identificação bloqueia atribuição. Reservas de tentativas e recibos de vídeos públicos não são tratados como a mesma evidência.

Depois de pelo menos dez vídeos identificados na janela, a média da faixa é comparada à mediana dos vídeos do canal. Duas janelas verificadas, adjacentes e sem sobreposição, com média ≤85% da mediana retiram a faixa. Reconsultar a mesma janela não conta outra reprovação. Acima da mediana, cresce o peso (até 2), respeitando alternância e teto. O efeito de retenção é uma regra operacional de associação, não prova causal de que a música produziu o resultado.

O relatório diário existente ganha uma seção lida do KV, com faixas novas, estado, decisões e link público para ouvir. Dados inválidos não viram decisões de desempenho. Não há novo envio de mensagens realizado nesta entrega.

## Workflow desligado

`shorts-music-curation.yml` tem agendas mensal de descoberta e diária de leitura de desempenho/relatório. Não tem entrada de dispatch. Só pode operar em `gh-pages`, com `SHORTS_MUSIC_CURATION_ENABLED=true`, `descoberta.enabled=true` e três aprovações explícitas (proprietário, Claude, GPT-6). **Todos esses gates de perfil entram false; nenhuma variável foi criada ou alterada.** A CLI desligada foi executada e reportou zero chamadas externas e zero promoções.

Como o workflow novo só existe no ramo do PR, não é declarado como `disabled_manually` na API do GitHub: o bloqueio entregue está no job e na configuração. A publicação de Shorts já existente continua desabilitada manualmente e suas aprovações de voz, plano gratuito e preview continuam false.

Quando autorizado no futuro, o job comita apenas gravações admitidas e seus dados, sem force-push nem merge, e só registra o relatório após o push. Mudança concorrente do ramo rejeita o push; não há reconciliação que apague veto do proprietário. O registro do relatório é separado da edição de vídeos. Nenhum desses caminhos foi executado nesta rodada.

## Reprodução

```bash
node --test tests/shorts-v2-round4.test.mjs
node --test tests/*.test.mjs
python3 -m unittest tests.test_node_suite_manifest
node --test tests/media/shorts-v2-media.test.mjs
node scripts/shorts-v2/preview-round3.mjs /tmp/shorts-review-render
node scripts/shorts-v2/simulate-round3.mjs /tmp/shorts-review-render/simulacao-180-dias.json
node scripts/shorts-v2/review-package.mjs /tmp/shorts-review /tmp/shorts-review-render
```

Sem merge, rótulo, dispatch, deploy, reabilitação, leitura de segredos, consulta Analytics real ou escrita remota de KV. O SHA e os checks remotos deste SHA ficam na descrição do PR. Session-guard, merge-impact, verificação com credencial e protected-paths permanecem pendências de governança; não foram contornados.
