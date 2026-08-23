# EVIDENCE GATE

ID da implementacao: EG-0008 / Deploy Zevanory na Vercel
Decisao proposta: publicar o ZEVANORY no projeto Vercel zevanory-site e preparar vinculo com zevanory.api.br em modo fail-closed.
Problema que resolve: tornar o projeto acessivel em dominio proprio sem reduzir as garantias de telemetria, autenticacao e integridade financeira.

## Evidencia 1
Fonte: Vercel - Project Configuration / Custom Domains / Environment Variables
Classe: A
Constatacao: a Vercel suporta aliases/custom domains, variaveis de ambiente e funcoes serverless; configuracao de dominio deve ser associada ao projeto correto.
Limites: documentacao de plataforma; nao prova que o dominio ja esteja configurado no DNS.

## Evidencia 2
Fonte: Auditoria interna ZEVANORY - validation/AUDIT-3X-CURRENT.json
Classe: A
Constatacao: o estado atual passou 16/16 unidades com 3 operacoes aprovadas por unidade e 19/19 testes automatizados.
Limites: garante o estado local auditado, nao o comportamento apos deploy.

## Evidencia 3
Fonte: Vercel API - projeto zevanory-site
Classe: A
Constatacao: existe projeto separado zevanory-site, com deployment de producao READY e sem dominio customizado atualmente associado.
Limites: requer novo deploy e verificacao do dominio apos publicacao.

## Convergencia e contradicoes
O que as fontes concordam: o deploy deve ocorrer no projeto zevanory-site, com validacao posterior de build, runtime e dominio.
O que diverge: o runtime Node local persistente nao deve ser assumido equivalente ao ambiente serverless.
O que permanece nao comprovado: DNS atual de zevanory.api.br e persistencia transacional de producao.

## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: build/deploy READY, pagina HTTP 200, dominio associado e sem regressao dos gates locais.
Kill-switch / rollback: manter CTA comercial bloqueado se telemetria de producao nao estiver persistente e autenticada.
