# EVIDENCE GATE

ID: EG-0019 / Dominio e DNS pre-venda
Decisao: dominio customizado so pode sair de bloqueado depois de associacao Vercel, DNS autoritativo correto, verificacao de posse quando exigida e HTTPS funcional.
Problema: impedir liberacao comercial com dominio inexistente, mal apontado ou pertencente a outro team.

## Evidencia 1
Fonte: Vercel - Setting up a custom domain
Classe: A
Constatacao: dominio deve ser adicionado ao projeto; Vercel informa o A/CNAME exato e a verificacao deve ser repetida apos propagacao.
Limite: valores DNS podem ser especificos do projeto; nao presumir alvo sem inspecao.

## Evidencia 2
Fonte: Registro.br - Gerenciamento de conta / DNS
Classe: A
Constatacao: dominios .br usam servidores autoritativos configurados pelo titular/provedor e alteracoes DNS sao publicadas periodicamente.
Limite: a interface autenticada do titular e necessaria para escrever a zona.
## Evidencia 3
Fonte: Cloudflare DNS - DNS record types
Classe: A
Constatacao: A/AAAA resolvem hostname para IP, CNAME aponta para hostname canonico e TXT e usado para verificacao de posse.
Limite: referencia tecnica independente; nao define valores especificos da Vercel.

## Estado observado
Autoritativos: a.auto.dns.br e b.auto.dns.br.
A/AAAA/CNAME no apex: ausentes.
TXT apex: v=spf1 -all.
TXT _vercel: ausente.

## Veredito
Veredito: APROVADO
Criterio: associacao Vercel comprovada + registro exigido pela Vercel presente nos autoritativos + propagacao em 3 resolvedores + HTTPS/rotas aprovados.
Kill-switch: qualquer ausencia, divergencia, 403 de posse, DNS parcial ou HTTPS invalido mantem custom_domain_unverified.
