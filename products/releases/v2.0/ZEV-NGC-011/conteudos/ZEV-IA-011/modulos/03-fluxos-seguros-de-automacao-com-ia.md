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
