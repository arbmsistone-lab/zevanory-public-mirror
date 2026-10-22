# P05 — análise pré-registrada da prova cega (ACR 5 pontos). NÃO EXECUTADA: a prova ainda não aconteceu.
# Entrada: notas.csv com colunas ouvinte, roteiro, condicao, clip_id, nota (1..5), valido (TRUE/FALSE), tipo.
# Pacotes: lme4, lmerTest, ordinal, emmeans (versões fixadas no relatório da execução).
suppressPackageStartupMessages({ library(lme4); library(lmerTest); library(ordinal); library(emmeans) })

MARGEM <- 0.3            # não inferioridade: candidata no máximo 0,3 MOS abaixo do humano oculto
ALFA <- 0.05             # bilateral (IC 95%); unilateral 0,025 por comparação antes da correção
HUMANO <- "C1_humano_referencia_oculta"
ANCORA <- "C6_piper_faber_medium_ancora"

d <- read.csv("notas.csv", stringsAsFactors = TRUE)
d <- subset(d, valido & tipo == "clip")
d$condicao <- relevel(factor(d$condicao), ref = HUMANO)

# Requisitos do desenho (veto de validade da rodada)
por_clip <- table(d$clip_id)
stopifnot(length(unique(d$ouvinte)) >= 48, min(por_clip) >= 24)

# 1) Modelo principal: MOS com efeitos aleatórios de ouvinte e roteiro (e interação roteiro:condição)
m <- lmer(nota ~ condicao + (1 | ouvinte) + (1 | roteiro) + (1 | roteiro:condicao), data = d, REML = TRUE)
emm <- emmeans(m, ~ condicao, lmer.df = "satterthwaite")
print(summary(emm, level = 0.95))

# 2) Não inferioridade vs humano (Holm sobre as 4 candidatas; a âncora fica fora da inferência)
cand <- setdiff(levels(d$condicao), c(HUMANO, ANCORA))
ct <- contrast(emm, method = "trt.vs.ctrl", ref = HUMANO)
ct <- ct[grepl(paste(cand, collapse = "|"), summary(ct)$contrast)]
ni <- test(ct, null = -MARGEM, side = ">", adjust = "holm")
ci <- confint(ct, level = 1 - 2 * ALFA / length(cand), adjust = "none")  # IC simultâneo (Bonferroni) p/ relatório
print(ni); print(ci)

# 3) Sensibilidade (ordinal): CLMM com os mesmos efeitos aleatórios; o sinal das diferenças deve concordar
mo <- clmm(factor(nota, ordered = TRUE) ~ condicao + (1 | ouvinte) + (1 | roteiro), data = d, link = "logit")
print(summary(mo))

# 4) Vetos (qualquer um anula a escolha):
mos <- aggregate(nota ~ condicao, d, mean)
baixa <- aggregate(nota ~ condicao, d, function(x) mean(x <= 2))
veto_humano <- mos$nota[mos$condicao == HUMANO] < 4.0                     # referência humana precisa ≥ 4,0
veto_ancora <- (mos$nota[mos$condicao == HUMANO] - mos$nota[mos$condicao == ANCORA]) < 0.5  # painel sensível
cat("veto_humano_abaixo_de_4:", veto_humano, " veto_ancora_nao_discriminada:", veto_ancora, "\n")
print(merge(mos, baixa, by = "condicao", suffixes = c("_mos", "_frac_1_2")))
# Regra: elegível = não inferior (p Holm < 0,025 unilateral) E fração de notas 1–2 ≤ 10% E nenhum roteiro com
# média < 3,5 E sem veto do proprietário E sem falha V2 (ASR) nos clipes da candidata. Entre as elegíveis, maior MOS;
# empate dentro de 0,1 MOS → menor custo mensal (tabela do DIAGNOSTICO_VOZ §4.2).
