# ADR-0002 - Evidence Gate 3X

Status: ACEITA

## Decisao
Toda implementacao do ZEVANORY exige Evidence Gate aprovado antes do codigo.

## Regras
- Minimo de 3 evidencias independentes.
- Minimo de 3 fontes/organizacoes distintas.
- Pelo menos uma evidencia classe A ou B.
- Marketing/opiniao sem metodo nao libera implementacao.
- Evidencia conflitante deve ser registrada.
- Implementacao deve definir teste posterior e rollback.

## Consequencia
Sem Evidence Gate valido, a implementacao fica BLOQUEADA.

## Motivo
Reduzir decisoes por suposicao, evitar complexidade nao comprovada e manter rastreabilidade entre evidencia, decisao, implementacao e resultado.
