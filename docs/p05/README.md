# P05 — `zevanory-av-gate`: gate pré-upload de vídeo com narração (V1–V8, fail-closed)

Este gate **escuta** o artefato que vai ser publicado. Ele roda sobre o **MP4/AAC final**, antes de qualquer upload
(YouTube, cross-post, hospedagem do pack), e devolve um veredito tipado: `PASS | FAIL | BLOCKED | ERROR_INFRA`. Só um `PASS` explícito
libera a publicação. Uma métrica ausente vira `BLOCKED`, e uma ferramenta com erro vira `ERROR_INFRA`. O gate nunca devolve PASS por omissão.

Código: `scripts/av_gate/zevanory_av_gate.py` · limiares: `scripts/av_gate/thresholds.json` · controles e mutantes:
`scripts/av_gate/controls.py` (CI: `.github/workflows/av-gate-controls.yml`, só em `pull_request`) · prova cega:
`docs/p05/prova-cega/`.

## Cadeia de produção (o que mudou na publicação)

1. **Voz única da marca:** `gemini-3.8-flash-tts`, voz `Achird`, persona `zevanory-brand`. O `style` vai curto **só** em
   `speech_metadata` e nunca é concatenado ao texto. **Não existe mais fallback** (Piper, flash-lite, 3.1-preview, 2.5-preview).
   Voz indisponível, ou o guarda de custo atingido, resulta em `brand_voice_BLOCKED`: não há publicação.
2. **Áudio:** corte de silêncio (0,15 s no início), **master WAV 48 kHz/24 bit em −23 LUFS, TP ≤ −1 dBTP**, derivado de
   streaming em −17,5 LUFS com **limitador true peak com sobreamostragem 4× como último estágio** e **um único encode AAC
   192k**. O TP é re-medido depois do encode, com alvo ≤ −2,3 dBTP. O vídeo faz `-c:a copy`, sem segunda compressão com perdas.
3. **Legendas** palavra a palavra, com texto igual ao roteiro aprovado e tempos do alinhamento do motor B. Ficam queimadas no cartão central (área segura)
   e também como `captions.vtt`.
4. **Manifesto** (`manifest.json`): roteiro, master, MP4, legendas com SHA-256, voz, `sales_mode=closed`, textos (título,
   descrição, link, tela), estilo das legendas e referência da voz da marca.
5. **Gate** sobre o MP4 final. Um `PASS` gera o selo `<arquivo>.av-gate.json` (`verdict` + `mp4_sha256`). O uploader,
   o cross-post e o pack **só aceitam um arquivo selado para exatamente aqueles bytes**.
6. **Vendas fechadas:** o slot "oferta" não tem mais preço, link `/comprar` nem garantia. Ele aponta para o material gratuito.
   O gate rejeita CTA ou preço de compra no roteiro, nas legendas, no título, na descrição, no link ou na fala.

## O que o gate mede (por critério do Sol)

| Critério | Medição | Limiar (FAIL fora dele) |
|---|---|---|
| V1 | presença de MP4, áudio, master, legendas, roteiro e manifesto; SHA-256; voz = voz da marca; taxa do master; duração master × MP4; **narração presente** (fala por VAD ≥ 1 s e loudness > −50) | qualquer item ausente = FAIL (vídeo mudo = FAIL) |
| V2 | **2 motores de famílias diferentes**: A = faster-whisper `small` (Whisper/CTranslate2), B = Vosk pt-BR (Kaldi). Normalização pt-BR (números, R$, %, URL, acentos, léxico da marca) | WER ≤ 3%, CER ≤ 1% (base consenso, ver abaixo); **0 erro** em número, preço, marca, negação e termos críticos; vazamento de instrução de estilo = FAIL; CTA de compra falado com vendas fechadas = FAIL |
| V3 | ffmpeg `ebur128=peak=true` (BS.1770) no master e no **MP4 final**; amostras clipadas; densidade de clipping no master; piso de ruído e SNR (VAD); proporção de fala; silêncio inicial; planura espectral, razão tonal, fração vozeada | master −23 ±0,5 LUFS e TP ≤ −1; derivado −20…−16 LUFS e TP ≤ −2; 0 amostras clipadas; ruído ≤ −50 dBFS; SNR ≥ 30 dB |
| V4 | ppm global e por janela de 10 s (tempos do motor B); pausas (VAD); desvio de F0 em semitons e energia (parselmouth); HNR; **x-vector** do locutor contra a referência da marca | 130–175 ppm; janelas 105–195; nenhuma pausa > 1,5 s; mediana das pausas entre 150 e 900 ms; F0 entre 1,5 e 8 st; cosseno do locutor ≥ limiar `provisional` |
| V5 | DNSMOS P.835 (OVRL/SIG), **só como filtro** | limiar `provisional`. Quem decide é o painel humano cego (`prova-cega/`) |
| V6 | offset de contêiner (start_time áudio × vídeo) + deriva legenda × fala (re-medida no MP4 final) | p95 ≤ 80 ms, máximo ≤ 120 ms |
| V7 | legenda = roteiro, formato (≤ 42 caracteres/linha, ≤ 2 linhas, ≤ 20 cps), tempo de legenda ≤ 100 ms, contraste WCAG ≥ 4,5, caixa da legenda dentro da área segura, quadros pretos, 1080×1920 | qualquer violação = FAIL |
| V8 | controles negativos e positivos + mutantes da decisão no CI | todos classificados e todos os mutantes mortos |

**Base do WER (contestação registrada).** Com os modelos pequenos do CI, o WER bruto de cada motor em fala humana fica acima de
3%. Aplicar 3% a cada motor reprovaria a própria referência humana (FALSE_DENY). O CI usa então o **consenso**: uma palavra do
roteiro só conta como erro se **nenhum** dos dois motores independentes a reconheceu, e uma inserção só conta se os dois a fizeram. Cada
motor continua com um teto de sanidade (`per_engine_wer_sanity_max`). Os termos críticos exigem reconhecimento por pelo menos um
motor e nenhum número ou negação a mais. **Em produção, o motor B deve migrar para um ASR de nuvem de outro fornecedor**
(Azure Speech ou Google STT), e `wer_basis` deve passar para `per_engine`.

## Controles (gerados no CI)

- **Positivos:** fala **humana** pt-BR com licença permissiva, baixada no runner: Google FLEURS `pt_br` (CC BY 4.0, frases lidas),
  com seleção declarada. O filtro de texto exclui nomes próprios, dígitos e símbolos. A triagem de envelope exige 138–168 ppm, SNR ≥ 38 dB,
  pausa máxima ≤ 900 ms e piso ≤ −45 dBFS. O texto da FLEURS é o roteiro, e a referência de locutor é a própria gravação
  (**autorreferência**: o V4-identidade fica só *ligado*, e o lado da rejeição é provado pelo N22/N24). Se nenhuma fala humana estiver
  alcançável, os positivos ficam BLOCKED, o espeak-ng só testa a fiação e o job falha.
- **Negativos:** cada um carrega **um** defeito, injetado no estágio em que ele acontece. Todos passam pela mesma cadeia de produção:
  tom puro, ruído branco, ruído rosa modulado, bipes, fala clipada, loudness fora, TP entre −2 e −0,3, TP grosseiro, silêncio,
  MP4 sem áudio, pausa longa, prosódia achatada (PSOLA), número trocado, marca não falada, instrução de estilo lida em voz alta,
  fala 1,4×, fala 0,7×, A/V +200 ms (contêiner), A/V +200 ms (embutido), legendas ausentes, CTA de compra com vendas fechadas,
  voz trocada, ruído de fundo (SNR 18 dB), voz robótica (espeak-ng).
- **Infra:** referência da voz ausente (precisa dar BLOCKED); motor B indisponível (precisa dar ERROR_INFRA).
- **Mutantes** (sobre as mesmas medições): sem VAD, sem ASR, TP aceito até −0,3, sem espectro, sem loudness, sem prosódia,
  sem taxa, sem sincronia, sem legendas, sem clipping, sem locutor, sem regra de vendas fechadas, sem ruído/SNR, BLOCKED como
  PASS, ERROR_INFRA como PASS, sem presença de narração. Um mutante é **morto** quando algum negativo vira PASS ou algum
  positivo deixa de ser PASS.

## O que depende do proprietário

1. **Gravação de referência da voz da marca** em `assets/brand/voice/brand-reference.wav` (pela prova cega, a voz vencedora
   aprovada). Sem ela, o V4-identidade fica BLOCKED e **nada é publicado**. É intencional.
2. **Gravações humanas pt-BR de referência** (os 12 roteiros da prova cega) para a calibração definitiva dos limiares
   `provisional` (V4 locutor, V5 DNSMOS). A calibração atual usa só FLEURS, que é fala lida de domínio aberto.
3. Chaves e contas dos provedores de TTS da prova cega e decisão de custo (tier pago do Gemini etc.).
4. ASR de nuvem de outro fornecedor como motor B em produção (Azure ou Google STT, com custo e decisão do proprietário).
5. Reativar os workflows `youtube-autonomous-short` e `short-pack` **é decisão do proprietário**. Esta mudança não os reativa.
