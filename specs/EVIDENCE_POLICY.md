# POLITICA DE EVIDENCIA 3X

Status: OBRIGATORIA para toda implementacao.

Nenhuma funcionalidade, agente, canal, automacao, regra de negocio ou decisao arquitetural pode ser implementada sem um Evidence Gate aprovado antes do codigo.

## Requisito minimo

1. Pelo menos 3 evidencias validas e independentes.
2. As 3 evidencias devem vir de pelo menos 3 organizacoes/fontes distintas.
3. Pelo menos 1 evidencia deve ser primaria, experimental, transacional ou documentacao tecnica oficial.
4. Case comercial de fornecedor pode compor o conjunto, mas nao pode ser a unica classe de evidencia.
5. Tres textos que repetem a mesma fonte contam como uma unica evidencia.
6. Opiniao de IA, sem fonte verificavel, nao conta como evidencia.
7. Evidencia conflitante deve ser registrada; nao pode ser omitida.
8. A conclusao deve declarar o que foi comprovado e o que continua hipotese.

## Classificacao

A = experimento causal, dado transacional auditavel ou documentacao tecnica primaria.
B = pesquisa robusta, benchmark independente ou estudo com metodologia explicita.
C = case de fornecedor ou benchmark comercial verificavel.
D = opiniao, marketing sem metodo ou inferencia nao testada.

Para aprovar implementacao: minimo 3 evidencias A/B/C, de 3 fontes, com pelo menos uma A ou B. Evidencia D nao libera implementacao.

Resultado do gate: APROVADO, APROVADO COM RESTRICOES ou BLOQUEADO.
