# EVIDENCE GATE

ID da implementacao: EG-0021
Decisao proposta: reconhecer dominio zevanory.api.br como tecnicamente associado a producao Vercel.
Problema que resolve: encerrar o blocker custom_domain_unverified somente apos prova DNS, ownership, HTTPS e rotas.

## Evidencia 1
Fonte: painel Registro.br e zona DNS em 2026-08-24
Classe: A
Constatacao: ZEVANORY.API.BR esta Publicado; zona contem TXT _vercel e A no apex para 216.198.79.1.
Limites: DNS pode sofrer caches temporarios fora dos resolvedores auditados.

## Evidencia 2
Fonte: consultas DNS 1.1.1.1, 8.8.8.8 e 9.9.9.9 em 2026-08-24
Classe: A
Constatacao: os tres resolvedores retornam zevanory.api.br A 216.198.79.1 e TXT _vercel com vc-domain-verify=zevanory.api.br,a32ddbb728c60849ecbe.
Limites: a verificacao cobre os tres resolvedores publicos exigidos pelo gate.

## Evidencia 3
Fonte: painel Vercel do projeto zevanory-site em 2026-08-24
Classe: A
Constatacao: zevanory.api.br aparece como Configuracao valida em Producao.
Limites: configuracao valida nao substitui teste de HTTPS e rotas.

## Evidencia 4
Fonte: curl HTTPS no dominio oficial em 2026-08-24
Classe: A
Constatacao: /, /piloto, /api/config, /api/release e /api/status retornam HTTP 200 com ssl_verify_result=0; rotas sensiveis rejeitam GET com 405 Method Not Allowed.
Limites: a aplicacao continua propositalmente fail-closed para venda e financeiro.

## Convergencia e contradicoes
O que as fontes concordam: ownership, apontamento DNS, HTTPS e roteamento do dominio oficial estao tecnicamente validos.
O que diverge: nenhuma divergencia material.
O que permanece nao comprovado: Asaas Sandbox ainda nao configurado; isso continua impedindo aprovacao pre-venda total.

## Veredito
Veredito: APROVADO
Criterio de teste apos implementacao: manter A/TXT corretos em 3 resolvedores, Vercel Configuracao valida, HTTPS valido e rotas criticas respondendo conforme contrato.
Kill-switch / rollback: manter vendas, checkout, WhatsApp comercial e eventos financeiros desabilitados; restaurar blocker de dominio se qualquer prova regredir.