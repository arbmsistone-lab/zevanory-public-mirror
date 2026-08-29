# EG-0042 — FINAL VISUAL CERTIFICATION

Status: APROVADO PARA PUBLICACAO.
Escopo: dashboard executivo ZEVANORY em viewport desktop fechado.

## Objetivo
Eliminar os ultimos microerros visuais detectados na captura real: truncamento inferior, compressao da coluna direita, microtipografia excessivamente pequena e overflow interno silencioso.

## Correcoes
- redistribuicao de largura favorecendo a coluna operacional;
- fatos comerciais sem elipse;
- microtipografia ampliada sem criar scroll;
- detalhes secundarios de Motor/Infra condensados em altura compacta;
- detalhes condensados preservados em tooltip operacional;
- cards da coluna direita obrigados a caber integralmente no viewport compacto.

## Criterio de aceite
Em 1280x720: overflow global X/Y = false; truncamentos detectados = 0; cada rail-card deve ter scrollHeight <= clientHeight; switches comerciais devem permanecer OFF enquanto fail-closed.

Esta fase nao altera backend, banco, checkout, pagamentos, WhatsApp comercial nem autonomia.