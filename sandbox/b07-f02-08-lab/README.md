# B07 / F02-08 — laboratório da cerca de escritor (época + dono)

Laboratório descartável: PostgreSQL 16 local, socket Unix, sem rede, sem segredos, sem banco real.
Executado em runner do GitHub pelo workflow `.github/workflows/b07-f02-08-lab.yml` (somente `pull_request`).

## Pergunta

O critério F02-08 exige que, depois de uma troca de escritor, o escritor antigo **não consiga** gravar.
O desenho avaliado é uma cerca dentro do banco: tabela `fence` (época + dono), trigger `ledger_fence` que recusa
qualquer escrita cuja época/dono não sejam os atuais, e `promote_writer` como compare-and-swap da época
(`fence.sql`).

## Experimento (`f02_08_lab.sh`)

1. **Cenário 1 — um nó (um único ponto de linearização).** Promoção W1 → W2 por CAS; promoção concorrente W3
   perde; o escritor antigo W1 recebe `ERROR: FENCED`; o novo escritor W2 grava. Resultado: a cerca funciona.
2. **Cenário 2 — dois nós e partição.** Dois clusters independentes (`initdb`/`pg_ctl` em portas diferentes):
   A primário, B réplica por `pg_basebackup`. A partição é simulada cortando o `primary_conninfo` de B, que é
   promovido e recebe a promoção para W2. O primário antigo A continua `in_recovery=f`, `read_only=off`, com a
   cerca ainda em `1/W1` — e **aceita** a escrita do escritor antigo. Os ledgers divergem:
   `A: op1:W1@1,op2:W1@1` contra `B: op1:W1@1,op2:W2@2` (a mesma operação gravada por dois escritores em duas
   épocas).
3. **Cenário 3 — `synchronous_standby_names` não é cerca.** Com a réplica fora, a escrita em A fica esperando
   `SyncRep`; ao cancelar a espera o PostgreSQL avisa *"The transaction has already committed locally"* e a linha
   fica visível em A.

## Mutantes (`mutantes.sh`)

Oito mutações do `fence.sql`, cada uma contra uma bateria de 10 verificações (F0–F9) num nó único:

| Mutante | Esperado |
|---|---|
| original | PASS |
| M1 sem época | KILLED |
| M2 comparação frouxa (`<`) | KILLED |
| M3a NULL só no trigger | **SURVIVED** — equivalente: a coluna `epoch` é `NOT NULL` e já recusa NULL |
| M3b NULL no trigger e na coluna | KILLED |
| M4 sem dono | KILLED |
| M5 trigger não bloqueante (`WARNING`) | KILLED |
| M6 promoção sem CAS | KILLED |
| M7 trigger sem `UPDATE` | KILLED |

## Conclusão

**F02-08 FAIL arquitetural.** A cerca dentro do banco só é correta quando existe **um** ponto de linearização.
Com dois nós e partição, o primário antigo não sabe da nova época e aceita o escritor antigo; replicação
síncrona não impede o commit local. Fechar F02-08 exige cerca fora do nó isolado (por exemplo, token de época
verificado por um ponto único de linearização ou isolamento do primário antigo antes da promoção), não um
trigger.

## Como a conclusão é conferida (`verificar.sh`)

O verificador compara linha a linha o log observado com o documentado acima e **falha** se qualquer
observação divergir — em especial, se o primário antigo **recusar** a escrita do escritor antigo no cenário 2
(nesse caso a afirmação "FAIL arquitetural" estaria errada). O workflow também prova que o verificador está
vivo: um log adulterado (A recusando o escritor antigo) tem de ser rejeitado.

Adaptação em relação ao laboratório original: o caminho dos binários aceita `PG_BIN`
(padrão `/usr/lib/postgresql/16/bin`); nada mais mudou nos scripts e no SQL.

Execução local (como root, usuário `postgres` existente):

```
bash f02_08_lab.sh /var/tmp/zev-b07-f0208 > lab.log 2>&1
bash mutantes.sh /var/tmp/zev-b07-mut > mut.log 2>&1
bash verificar.sh lab.log mut.log
```
