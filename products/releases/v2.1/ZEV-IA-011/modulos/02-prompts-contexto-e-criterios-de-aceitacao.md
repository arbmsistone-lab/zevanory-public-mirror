# ZEVANORY IA na Prática — Módulo 2

## Prompts, contexto e critérios de aceitação

## Objetivo
Transformar pedidos vagos em instruções reproduzíveis e auditáveis.

## Estrutura CTCV
- **Contexto:** situação, público, restrições e dados disponíveis.
- **Tarefa:** ação concreta esperada.
- **Critérios:** o que precisa estar presente para a resposta ser útil.
- **Validação:** como conferir fatos, formato e limites antes de usar.

## Técnica
Peça saída estruturada, declare o que a IA não deve inferir e inclua exemplos apenas quando representarem o caso real. Separe fatos fornecidos de hipóteses. Para tarefas recorrentes, versione o prompt e registre alteração, motivo e resultado.

## Exercício
Reescreva três prompts usados no negócio. Para cada um, defina cinco critérios objetivos e uma condição de rejeição.

## Padrão de execução
- Trabalhe com dados reais do próprio negócio, sem inventar números.
- Defina baseline, meta, responsável, prazo e evidência antes de mudar o processo.
- Faça mudanças pequenas e reversíveis; preserve histórico e registre decisões.
- Revise semanalmente resultado, custo, tempo, risco e próxima decisão.
- Não automatize decisão financeira, jurídica, fiscal ou publicação sensível sem revisão humana apropriada.

## Critério de domínio
Você concluiu este módulo quando consegue explicar o método, preencher o exercício com dados reais, justificar a decisão tomada e apontar qual evidência faria você mudar de opinião.
## Camada Master/Sênior

### Decisão sob pressão
Se o indicador principal piorar por duas semanas, separe fato, hipótese e decisão. Declare a evidência mínima que autorizaria a mudança e a condição objetiva de rollback.

### Falhas que reprovam
- Automatizar sem baseline.
- Usar dado sensível sem necessidade.
- Tratar saída do modelo como fato.
- Ignorar fallback e revisão humana.

### Caso-limite
Construa um cenário em que a técnica deste módulo não deve ser aplicada. Explique o risco, a alternativa segura e quem precisa aprovar a exceção.

### Rubrica 100/100
A aprovação exige 20/20 em diagnóstico, execução, evidência, gestão de risco e clareza da próxima decisão. Qualquer dimensão abaixo de 20 deve ser corrigida e reapresentada.

### Desafio de domínio
Explique prompts, contexto e critérios de aceitação para outra pessoa, aplique a um caso real, apresente evidência antes/depois e responda a três objeções sobre sua decisão sem recorrer a autoridade ou promessa.
