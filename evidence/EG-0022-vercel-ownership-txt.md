# EVIDENCE GATE

ID da implementacao: EG-0022
Decisao proposta: registrar o requisito oficial atual de ownership Vercel sem aprovar o dominio antes da propagacao DNS.
Problema que resolve: transforma o blocker 403 em requisito tecnico objetivo e auditavel.

## Evidencia 1
Fonte: painel Vercel do projeto zevanory-site em 2026-08-23
Classe: A
Constatacao: zevanory.api.br aparece como Verification Required e informa que o dominio esta vinculado a outra conta Vercel.
Limites: o painel exige publicacao DNS antes de concluir o claim.

## Evidencia 2
Fonte: painel Vercel em 2026-08-23
Classe: A
Constatacao: registro requerido e TXT com host _vercel e valor vc-domain-verify=zevanory.api.br,a32ddbb728c60849ecbe.
Limites: o valor e valido para o estado atual e deve ser reconfirmado se a plataforma alterar a verificacao.

## Evidencia 3
Fonte: DNS publico + CLI Vercel em 2026-08-23
Classe: A
Constatacao: _vercel.zevanory.api.br ainda retorna NXDOMAIN e a associacao continua em HTTP 403.
Limites: o estado pode mudar apos publicacao e propagacao do TXT.

## Convergencia e contradicoes
O que as fontes concordam: o dominio existe, mas a propriedade tecnica ainda nao foi comprovada para esta conta Vercel.
O que diverge: nenhuma divergencia material.
O que permanece nao comprovado: TXT propagado, claim concluido, endereco A/AAAA ou CNAME funcional, HTTPS e rotas no dominio oficial.

## Veredito
Veredito: BLOQUEADO
Criterio de teste apos implementacao: publicar o TXT exato, confirmar em 1.1.1.1/8.8.8.8/9.9.9.9, repetir o claim Vercel e validar HTTPS + rotas 200.
Kill-switch / rollback: manter SALE_GLOBALLY_ENABLED, PRE_SALE_GATES_APPROVED, CHECKOUT_ENABLED, WHATSAPP_SALES_ENABLED e FINANCIAL_EVENTS_ENABLED desligados.
