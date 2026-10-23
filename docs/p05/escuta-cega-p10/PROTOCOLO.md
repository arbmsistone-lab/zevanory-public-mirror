# P05 — Escuta cega do P10 (AVAL 098, opção b)

**Estado:** kit pronto, **não executado**. Nada é publicado, e nenhum áudio vai para o repositório. Até a escuta terminar,
o P10 fica registrado como **PENDENTE_REVISAO_HUMANA** em `pendentes.json`. Isso não conta como aprovado: o job de
controles continua vermelho por ele.

## Pergunta
No clipe FLEURS `10010073088196743714.wav`, o leitor disse "desta … podem" (como na transcrição oficial) ou
"dessa … pode" (o que os dois motores independentes ouviram)?

## Procedimento
1. O condutor roda `python3 montar_kit.py --out <pasta-local>` e registra o SHA-256 do `gabarito_SELADO.json` no
   comentário da PR **antes** da escuta.
2. São **≥ 3 avaliadores**: nativos de pt-BR, com fone de ouvido, independentes, que não conhecem a hipótese e não se falam. Cada um
   recebe só `itens/` e `folha_avaliador.md`. Os três itens (A/B/C) estão embaralhados: o pendente, um controle limpo
   (esperado: nenhuma diferença) e o mesmo controle com 2 palavras trocadas no texto (esperado: as 2 diferenças).
3. **Validade do avaliador:** ele precisa achar as 2 trocas do controle alterado e não marcar nada no controle limpo.
   Avaliador inválido é substituído.
4. **Decisão (pré-registrada):**
   - ≥ 2 de 3 avaliadores válidos marcam "desta→dessa" **e** "podem→pode": **desvio confirmado**. O P10 sai dos
     positivos por transcrição incorreta, e o motivo fica registrado em `pendentes.json`.
   - Nenhuma diferença marcada por ≥ 2 de 3: **FALSE_DENY confirmado**. O gate precisa ser corrigido; nada é afrouxado
     antes dessa correção.
   - Qualquer outro resultado: a escuta é repetida com mais 3 avaliadores.
5. O condutor abre o gabarito e publica na PR o resultado (folhas digitalizadas sem nomes e o SHA-256 conferido).
