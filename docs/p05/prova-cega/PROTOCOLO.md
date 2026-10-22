# P05 — Kit da prova cega de voz (pt-BR)

**Estado:** kit pronto, **não executado**. Nada aqui publica, contrata ou grava. A execução depende do proprietário
(gravação humana de referência, chaves dos provedores de TTS, recrutamento do painel).

Este protocolo segue o critério V5 do Sol: o MOS preditivo do `zevanory-av-gate` é **apenas filtro**. Quem escolhe a voz da
marca é este painel humano cego. Ele acontece no lote de calibração e de novo a cada troca de voz ou de modelo.

## 1. Material congelado

| Arquivo | O que é |
|---|---|
| `roteiros.json` | 12 roteiros pt-BR congelados (33–40 palavras, cerca de 15 s cada). Cobrem marca, preços, números decimais e grandes, porcentagem, siglas (MEI, DAS, CNPJ, Pix, IA), URL falada, perguntas, listas, emoção (empatia e entusiasmo), negação, aviso legal e palavras regionais |
| `roteiros.sha256` | SHA-256 de cada texto e do arquivo. Qualquer edição invalida a rodada |
| `desenho.py` | Gerador determinístico da alocação (blocos balanceados e aleatorizados) |
| `analise.R` | Análise pré-registrada (modelo misto, IC 95%, não inferioridade, Holm, vetos) |

Os roteiros têm preço só em **contexto de cálculo**. Nenhum deles tem CTA de compra (vendas fechadas). O material é de teste
e não é publicado.

## 2. Condições (6)

| Código | Condição | Papel |
|---|---|---|
| C1 | **Referência humana oculta**: locutor(a) pt-BR profissional, gravado pelo proprietário em ambiente tratado (WAV 48 kHz/24 bit), lendo os 12 roteiros | âncora superior oculta. Também é a referência do V4 (embedding do locutor), se a voz humana for adotada |
| C2 | Gemini 3.8 Flash TTS, **tier pago**, persona de voz projetada, `style` curto em `speech_metadata` | candidata |
| C3 | Google Cloud TTS Chirp 3 HD pt-BR | candidata |
| C4 | Azure DragonHD pt-BR (Thalita ou Macerio) | candidata |
| C5 | ElevenLabs v3 / Multilingual v2 (licença comercial) | candidata |
| C6 | Piper `pt_BR-faber-medium` (a voz de fallback antiga) | **âncora inferior** e controle de sensibilidade do painel |

Preparação idêntica para todas as condições: mesmo roteiro, normalização para −23 LUFS (BS.1770-5), TP ≤ −1 dBTP,
48 kHz, 0,3 s de silêncio no início e no fim, sem música e sem vídeo. Todos os clipes passam antes pelo
`zevanory-av-gate` nos estágios V2 (ASR) e V3 (técnico). Um clipe com erro de palavra crítica é **regravado**, nunca
avaliado. Os nomes dos arquivos são cegos (`clip_<hash>`), e a planilha de-para fica só com o condutor.

## 3. Painel e desenho

- **Ouvintes:** nativos de pt-BR, residentes no Brasil, 18 anos ou mais, sem queixa auditiva, com fone de ouvido.
  Recrutar **64** para garantir **≥ 48 válidos**. As regiões vêm em cotas (N/NE, CO, SE, S), com pelo menos 8 ouvintes válidos por macro-região.
- **Escala:** ACR de 5 pontos (ITU-T P.800/P.808). Pergunta: "Qual a qualidade e a naturalidade desta voz?"
  1 Ruim · 2 Pobre · 3 Razoável · 4 Boa · 5 Excelente.
- **Blocos balanceados e aleatorizados:** 72 clipes (12 × 6) divididos em 2 blocos complementares de 36. Cada bloco
  tem cada roteiro 3× e cada condição 6×. Os ouvintes alternam os blocos A e B. A ordem é aleatória por ouvinte, com semente
  registrada, sem repetir roteiro em sequência e sem a mesma condição 3× seguidas.
  Com 48 ouvintes válidos, **cada clipe recebe exatamente 24 notas válidas** (mínimo exigido: ≥ 24).
- **Sessão:** cerca de 20 min. Começa com 4 clipes de treino fora do desenho, que cobrem a faixa de qualidade. Seguem 36 clipes,
  2 armadilhas ("marque a nota N") e 1 clipe repetido.
- **Qualificação (P.808):** teste de fone (tons por canal), checagem de ambiente e triagem de idioma.

## 4. Validade do ouvinte

O ouvinte é excluído, e substituído na **mesma linha** do desenho, se:
- errar qualquer armadilha;
- der notas a ≥ 2 pontos de distância no clipe repetido;
- deixar mais de 10% das notas em menos de 50% da duração do clipe;
- tiver variância zero (todas as notas iguais);
- falhar no teste de fone.

## 5. Análise (pré-registrada, `analise.R`)

1. **Modelo misto:** `nota ~ condição + (1|ouvinte) + (1|roteiro) + (1|roteiro:condição)`. Relatório com MOS por condição e IC 95%
   (Satterthwaite).
2. **Não inferioridade** de cada candidata (C2–C5) contra o humano oculto (C1), com **margem de 0,3 MOS**: H0 Δ ≤ −0,3,
   unilateral α = 0,025, **correção de Holm** sobre as 4 comparações, mais o IC simultâneo de Bonferroni no relatório.
3. **Sensibilidade:** CLMM ordinal (logit) com os mesmos efeitos aleatórios. O sinal das diferenças precisa concordar com o modelo misto.
4. **Vetos** (qualquer um vale):
   - a referência humana tem MOS < 4,0 (rodada inválida);
   - Humano − Piper < 0,5 MOS (painel insensível, rodada inválida);
   - a candidata tem > 10% de notas 1–2, ou um roteiro com média < 3,5;
   - a candidata teve falha V2 (palavra crítica, vazamento de instrução, CTA com vendas fechadas);
   - **o proprietário vetou** após ouvir os clipes da candidata, mesmo que ela seja estatisticamente elegível.
5. **Decisão:** entre as candidatas não inferiores e sem veto, vence a de maior MOS. Um empate dentro de 0,1 MOS é decidido pelo menor custo
   mensal. A vencedora vira a **voz única da marca** (modelo, voz e persona fixos) e a referência do V4. A gravação da vencedora,
   aprovada pelo proprietário, passa a ser o `brand-reference.wav` do gate.

## 6. Depois da escolha

- Recalibrar os limiares `provisional` do gate (`scripts/av_gate/thresholds.json`: V4 `speaker_cos_min` e V5 DNSMOS)
  com as gravações da vencedora e do humano. O limiar fica **entre** o humano/vencedora e o Piper, medido no runner.
- Fazer amostragem semanal (2 clipes publicados por semana) para 12 ouvintes, mais o veto do proprietário. Repetir a prova completa a
  cada troca de voz, de modelo ou de persona.

## 7. O que o proprietário precisa fornecer

1. Gravação humana pt-BR dos 12 roteiros (C1), com licença de uso para teste e calibração.
2. Chaves e contas dos provedores C2–C5 (tier pago do Gemini; billing GCP para Chirp; Azure Speech; ElevenLabs Creator ou
   superior). Cada custo exige aprovação expressa, pela regra de custo zero.
3. Canal de recrutamento do painel (rede própria ou painel pago) e aceite do termo de participação (LGPD: notas
   anônimas, sem dado pessoal além de faixa etária e região).
