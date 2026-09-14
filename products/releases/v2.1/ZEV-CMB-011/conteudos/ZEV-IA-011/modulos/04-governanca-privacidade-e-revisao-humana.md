# ZEVANORY IA na Prática — Módulo 4

## Governança, privacidade e revisão humana

## Objetivo
Usar IA sem perder controle sobre dados, responsabilidade e qualidade.

## Classificação prática de dados
- Público: pode circular sem restrição relevante.
- Interno: informações operacionais que não devem ser publicadas.
- Confidencial: dados pessoais, financeiros, comerciais sensíveis ou estratégicos.

## Regras
Minimize dados enviados, remova identificadores quando possível, restrinja acesso, registre finalidade e retenção e nunca trate saída de modelo como prova factual sem verificação. Defina quem aprova cada categoria de ação e o que deve ser escalado.

## Checklist de revisão
Fato confirmado? Fonte adequada? Dado sensível necessário? Ação reversível? Existe impacto em pessoa, dinheiro, contrato ou reputação? Há log suficiente para auditoria?

## Exercício
Classifique cinco fluxos reais e determine o nível de revisão humana de cada um.

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
Explique governança, privacidade e revisão humana para outra pessoa, aplique a um caso real, apresente evidência antes/depois e responda a três objeções sobre sua decisão sem recorrer a autoridade ou promessa.
