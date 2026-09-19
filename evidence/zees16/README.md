# ZEES-16 Evidence Registry

Este diretorio guarda **evidencia tecnica de apoio** para o ZEVANORY Engineering Excellence Standard (ZEES-16).

Regras:

- fail-closed: ausencia de prova integral nunca vira PROVADO;
- evidencia de candidato/PR nao substitui o estado do branch/release canonico;
- uma pagina HTTP 200 prova disponibilidade pontual, nao observabilidade integral;
- static audit prova apenas os controles que ele executa;
- paridade de blob permite ligar o resultado do audit ao conteudo publicado, mas nao amplia o escopo do audit;
- falhas e resultados negativos sao preservados como evidencia, inclusive score 0.0 e artefatos;
- ARBM ONE e ZEVANORY ONE sao alvos distintos e nao compartilham evidencia automaticamente.

O arquivo `current.json` e um snapshot auditavel do estado de evidencia capturado em 19/09/2026. Ele nao e um manifesto de aprovacao e nao interfere no gate legado `evidence/approvals`.
