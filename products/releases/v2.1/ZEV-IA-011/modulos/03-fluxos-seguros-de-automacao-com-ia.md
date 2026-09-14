# ZEVANORY IA na Prática — Módulo 3

## Fluxos seguros de automação com IA

## Objetivo
Desenhar automações que falham de forma controlada e preservam rastreabilidade.

## Arquitetura mínima
Entrada validada → classificação → geração/análise → verificação → ação permitida → log → revisão.

## Controles
- Idempotência para impedir ação duplicada.
- Timeout e fallback quando o provedor falha.
- Limite de escopo e lista de ações proibidas.
- Aprovação humana para financeiro, publicação sensível, exclusão ou alteração irreversível.
- Log contendo entrada resumida, decisão, modelo/provedor, resultado e exceção.

## Exercício
Desenhe um fluxo real do seu negócio, identifique três pontos de falha e defina o comportamento seguro para cada um.

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
Explique fluxos seguros de automação com ia para outra pessoa, aplique a um caso real, apresente evidência antes/depois e responda a três objeções sobre sua decisão sem recorrer a autoridade ou promessa.
