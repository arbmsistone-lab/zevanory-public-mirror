# EG-0038 - COMMERCIAL ACTIVATION READINESS

Status: IMPLEMENTACAO TECNICA, SEM AUTORIZACAO DE VENDA AUTOMATICA.
Release alvo: ZEVANORY-EG0038-FINAL.

## Objetivo
Deixar a ZEVANORY pronta para ativacao comercial sem nova construcao de software.
A fase transforma requisitos externos em blockers verificaveis, ordena cutover e rollback e mantem fail-closed ate todos os inputs reais existirem.

## Regras
- Regra absoluta: nao fabricar razao social, CNPJ/CPF, endereco, credencial, fornecedor ou afiliacao.
- Nenhum segredo pode ser retornado pela API publica de readiness.
- A prontidao de inputs nao habilita venda por si so.
- `SALE_GLOBALLY_ENABLED` deve ser o ultimo gate mutavel do cutover.
- Rollback deve desligar vendas globais primeiro e restaurar todos os gates para `false`.
- Forecast, scoring e resultado comercial continuam dependentes de baseline real.

## Implementacao
- `src/activationPlan.mjs`: mapa canonico de requisitos, ordem de cutover e rollback.
- `GET /api/activation/readiness`: estado agregado sem valores de segredos.
- `npm run activation:check`: prova read-only de prontidao tecnica e comercial.
- `npm run audit:activation:20x`: auditoria especifica da ativacao.
- Quality Gate e Production Monitor passam a verificar readiness continuamente.

## Estado esperado antes dos dados externos
`activation_phase=waiting_external_inputs`, `commercial_enabled=false` e lista explicita dos blockers ainda reais.
Isso representa prontidao tecnica completa sem falsa prontidao legal/comercial.

## Veredito
APROVADO para implantacao estrutural. A fase nao autoriza vendas reais sem inputs externos validos e gates explicitamente liberados na ordem definida.

