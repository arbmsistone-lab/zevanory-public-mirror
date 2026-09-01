# ARBM SIST — Cluster de Autoridade Organica

Status: PRE-PUBLICACAO / SEM ACAO COMERCIAL
Marca-mae: ZEVANORY
Produto: ARBM SIST 8.1.0

## Tese central
ARBM SIST e um agente de desenvolvimento com IA local-first para Windows, orientado a controle de engenharia: isolamento por worktree, revisao por diff, testes, promocao controlada e rollback.

## Pilar 1 — Alternativa ao Codex
Intencao: alternativa ao Codex, agente de programacao com IA, agente local-first.
Pergunta principal: quando faz sentido preferir um fluxo local-first com controle explicito sobre a mudanca?
Prova: demonstrar uma tarefa real desde a worktree ate o rollback.
CTA permitido enquanto gates fechados: conhecer a proposta / entrar na lista de lancamento.

## Pilar 2 — Codex vs Claude Code vs Cursor vs ARBM SIST
Intencao: comparacao antes da escolha.
Regra editorial: nao declarar vencedor universal.
Eixos: ambiente, dependencia de cloud, isolamento, revisao, rollback, testes, integracoes e modelo operacional.
Resultado esperado: ajudar o leitor a escolher pelo proprio fluxo.

## Pilar 3 — Agente de IA local para Windows
Intencao: privacidade operacional, Windows, desenvolvimento local.
Mensagem: cloud e opcional no ARBM SIST; controle do processo continua local quando esse modo e escolhido.
Prova: executar fluxo sem exigir envio padrao do projeto a um provedor cloud.

## Pilar 4 — Engenharia auditavel com IA
Intencao: como usar IA sem perder controle sobre codigo.
Perguntas: o que mudou, como revisar, como testar, como voltar?
Prova: diff legivel + gate de teste + rollback reproduzivel.

## Pilar 5 — Fluxo seguro para mudancas grandes
Intencao: refatoracao, migracao e tarefas de maior risco.
Conteudo: separar mudanca em worktree, validar, comparar e promover somente apos gates.
Diferencial editorial: mostrar limites e falhas, nao somente o caso perfeito.

## Banco inicial de titulos
- ARBM SIST: alternativa ao Codex para quem quer controle local
- Agente de IA local para Windows: como preservar revisao e rollback
- Codex vs Claude Code vs Cursor vs ARBM SIST: escolha pelo fluxo, nao pelo hype
- Como usar IA para programar sem abrir mao do diff e dos testes
- Worktrees com IA: por que isolamento importa em mudancas grandes
- O que um agente de programacao precisa provar antes de alterar sua branch principal
- Local-first ou cloud-first? Como escolher um agente de IA para desenvolvimento
- Rollback com IA: o recurso que importa quando uma mudanca da errado

## Regra de qualidade
Cada ativo deve responder uma pergunta real, mostrar ao menos uma evidencia tecnica e evitar repeticao de texto entre canais.
