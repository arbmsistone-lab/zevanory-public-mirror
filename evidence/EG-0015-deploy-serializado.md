# EVIDENCE GATE

ID: EG-0015 / Deploy serializado e promocao controlada
Decisao: serializar deploys de producao e promover somente deployment completo, testado e identificado.
Problema: deploy concorrente parcial pode reassumir o alias e remover rotas ja validadas.

## Evidencia 1
Fonte: Vercel Deployments / Promote - https://vercel.com/docs/deployments/promote-preview-to-production
Classe: A
Constatacao: Vercel permite criar deployment sem atribuir dominio, inspecionar/testar e depois promover um deployment especifico para producao.
Limite: a plataforma nao impede por si so outro operador de promover um deployment depois.

## Evidencia 2
Fonte: GitHub Actions Concurrency - https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency
Classe: A
Constatacao: concurrency garante que somente um workflow/job do mesmo grupo execute por vez; deploys podem ser enfileirados em sequencia.
Limite: ZEVANORY ainda nao possui remote Git/Actions configurado.

## Evidencia 3
Fonte: Google Cloud Deploy - https://docs.cloud.google.com/deploy/docs/overview
Classe: A
Constatacao: releases sao promovidas por sequencia controlada de rollout e podem exigir aprovacao antes do alvo de producao.
Limite: fornecedor alternativo; sustenta o principio operacional, nao a implementacao Vercel.

## Convergencia e contradicoes
As tres fontes convergem em promocao controlada, uma release identificada por vez e verificacao antes de producao.
O incidente local comprovou que um deployment concorrente parcial pode alterar o alias mesmo quando o deployment anterior permanece READY.
Ainda nao comprovado: bloqueio tecnico centralizado entre todos os chats; por isso a verificacao do alias e obrigatoria antes/depois da promocao.

## Veredito
Veredito: APROVADO
Criterio: criar deployment completo sem alias, inspecionar manifest, testar rotas, promover o deployment exato e confirmar que o alias aponta para o mesmo deployment durante a auditoria final.
Kill-switch: alias apontando para outro deployment, manifest incompleto ou qualquer rota esperada ausente bloqueia a release.
