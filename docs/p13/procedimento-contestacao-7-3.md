# P13: procedimento de contestação (chargeback) e disputa, seção 7.3

Fonte: roteiro v4.9.1, seção 7.3 (Sol 296/M6), 7.1 (H-2 e H-6) e 12-B.5. Vale para **todos os canais**: Hotmart
(canal atual, DEC-06) e checkout próprio (fechado). No checkout próprio, este procedimento complementa o item (10)
da fase F2, que é em sandbox. A máquina de estados que impõe a ordem e as travas deste procedimento é
`scripts/p13/contestacao-7-3.mjs`, ensaiada em `tests/p13-posvenda-ensaio.test.mjs` (V11, V12 e V14).
**Avaliação jurídica: informação, não aconselhamento formal.**

**REVISÃO HUMANA OBRIGATÓRIA:** toda resposta de disputa, toda suspensão de acesso e todo resultado são revisados e
decididos pelo proprietário. Nada aqui é automático.

## Etapas

1. **Receber o aviso.** Os avisos chegam pelo postback da Hotmart (`PURCHASE_CHARGEBACK` ou `PURCHASE_PROTEST`, só
   informativo, H-2), pelo painel da Hotmart (fonte de verdade) ou, no checkout próprio, pelo Mercado Pago. O
   mesmo aviso repetido não abre um segundo caso.
2. **Registrar com protocolo.** Cada caso recebe um protocolo interno (`ZV-DSP-…`) com a data do aviso, a plataforma
   e o **prazo da plataforma para responder**, copiado do aviso. Sem prazo registrado, o caso não avança: os prazos
   de contestação e disputa da Hotmart estão **[NÃO VERIFICADOS]** no roteiro (H-6) e precisam ser lidos em cada
   aviso. Enquanto a contestação estiver aberta, não se abre estorno paralelo (decisão `contestacao_em_andamento`).
3. **Reunir a evidência de entrega.** A evidência sai dos registros de liberação de acesso na área de compras
   (painel da Hotmart), dos registros de envio, dos termos aceitos, da política publicada e das comunicações. Dado
   pessoal vai **mascarado**: e-mail como `c***@e***.invalid`, sem CPF, sem telefone e com a transação truncada ou
   em hash. O único e-mail em claro permitido é suporte@zevanory.api.br. Sem um registro de acesso ou de envio, a
   evidência é recusada.
4. **Responder dentro do prazo da plataforma.** O texto parte do modelo HM-03 de `docs/p13/respostas-prontas.md` e
   só sai com a revisão do proprietário. Resposta depois do prazo vira **prazo perdido** e gera alerta ao
   proprietário.
5. **Registrar o resultado.** O resultado (favorável ou desfavorável) e a causa ficam no protocolo. **Disputa
   decidida contra a ZEVANORY por falha de entrega é falha crítica de P12**: aciona a trava da seção 1 e exige
   análise de causa.
6. **Alimentar P24 e P25.** O motivo da contestação entra na revisão semanal (P25) e na conferência material ×
   página (P24).

## Suspensão de acesso

O acesso ao produto só é suspenso conforme a política publicada e o CDC, com o registro da base na política e a
decisão do proprietário. Sem base registrada, a suspensão é recusada (V12.7). Na Hotmart, a revogação de acesso
depois do estorno ou da contestação é feita pela plataforma; a verificação real fica para a compra de teste
autorizada (P1.4, critério 7).

## Dados e retenção (12-B.5)

- Fluxo "contestação": a finalidade é defender a ZEVANORY em disputa de pagamento; a base legal é o exercício
  regular de direitos (LGPD art. 7º, VI). A conferência jurídica dessa base fica com o proprietário.
- Prazo de guarda: o mesmo dos dados de compra e pagamento da política de privacidade publicada (5 anos, prazos
  fiscais).
- Quem acessa: só o proprietário.
- O protocolo e o resultado ficam sem dado pessoal em claro.

## O que falta para operar

- O proprietário precisa registrar por escrito os prazos de contestação e disputa da Hotmart para a conta real (H-6).
- Falta conferir se a ZEVANORY aderiu ao consumidor.gov.br e qual é o prazo vigente.
- O ensaio em sandbox do item (10) da F2 fica para o checkout próprio, que hoje está fechado.
