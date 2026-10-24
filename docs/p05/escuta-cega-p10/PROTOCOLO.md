# P05 — Escuta cega do P10 · protocolo v2 (AVAL do Sol)

**Estado:** kit pronto, **não executado**. Nada é publicado, e nenhum áudio vai para o repositório. Até o resultado, o P10 fica
como **PENDENTE_REVISAO_HUMANA** (`pendentes.json`). Isso não conta como aprovado: o job de controles continua vermelho.

## O que mudou em relação à v1 (bloqueios do Sol)
- A v1 usava o **mesmo WAV** nos dois controles, o que quebrava o cegamento. Agora são três fontes **distintas**: o pendente, um controle limpo
  e um **terceiro** clipe para a troca de palavras. `montar_kit.py` recusa fontes com o mesmo conteúdo.
- O hash puro do gabarito era enumerável. Agora o selo é **HMAC-SHA256(sal secreto, JSON canônico do gabarito)**. O selo é publicado antes
  da escuta, e o sal e o gabarito só depois de todas as folhas recebidas.
- São **5 avaliadores**, e cada um recebe um **pacote próprio**, com ordem própria e nomes de arquivo próprios (tokens aleatórios).

## Pergunta
No clipe FLEURS `10010073088196743714.wav`, o leitor disse "desta … podem" (transcrição oficial) ou "dessa … pode" (o que os
dois motores independentes ouviram)?

## Procedimento
1. O condutor roda `python3 montar_kit.py --out <pasta-local>` e publica na PR o **SELO** impresso. `SAL_SECRETO.txt` e
   `gabarito_SELADO.json` ficam só com o condutor.
2. Cada avaliador recebe só `avaliador_N/`, com os 3 WAVs de nomes aleatórios e `folha.md`. Os avaliadores são nativos de pt-BR, usam fone de ouvido, são independentes,
   não conhecem a hipótese e não se falam. Cada um preenche `formulario.csv` ou a folha.
3. **Validade do avaliador:** nenhuma marcação no controle LIMPO **e** as 2 trocas do controle TROCADO marcadas.
4. Depois de receber as 5 folhas, o condutor revela o sal e o gabarito, e qualquer pessoa confere o selo (`verify_seal`).
5. **Regra de decisão pré-registrada** (`montar_kit.decide`):
   - **VERDADEIRO_NEGATIVO** (a rejeição do gate estava certa, porque o leitor desviou da transcrição) **só se ≥ 4 de 5** avaliadores **válidos**
     marcarem "desta" **e** "podem" no pendente **e** os dois controles se comportarem como esperado nesses avaliadores. Nesse caso o P10 sai
     dos positivos por transcrição incorreta, e o motivo fica registrado em `pendentes.json`.
   - **FALLBACK_REPETIR_COM_NOVOS_AVALIADORES**, se houver menos de 4 avaliadores válidos: a escuta é repetida **uma vez** com 5 avaliadores novos e
     um kit novo (sal novo).
   - **FALLBACK_FALSE_DENY_PROVAVEL**, se houver 4 ou mais válidos mas menos de 4 identificarem o desvio, ou se a repetição também não fechar: o caso conta como
     **FALSE_DENY** do gate, e o gate precisa ser corrigido. Nada é afrouxado antes dessa correção, e o P10 continua vermelho até lá.
