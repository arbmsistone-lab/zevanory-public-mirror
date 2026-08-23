# EVIDENCE GATE

ID: EG-0011 / G3 Neon Persistencia
Decisao: usar Neon Serverless Postgres como persistencia exclusiva do ZEVANORY.
Supabase: PROIBIDO no ZEVANORY; reservado a outro sistema por decisao do proprietario.

## Evidencia 1
Fonte: PostgreSQL Documentation - Reliability / WAL
Classe: A
Constatacao: PostgreSQL usa WAL para durabilidade e recuperacao de transacoes confirmadas.
Limite: o aplicativo ainda precisa garantir qualidade e idempotencia dos eventos.

## Evidencia 2
Fonte: Vercel Marketplace - Neon for Vercel
Classe: A
Constatacao: Neon e integracao nativa Vercel, provisiona Postgres gerenciado, serverless, branching, autoscaling, recuperacao e plano inicial gratuito.
Limite: integracao de plataforma nao substitui schema, constraints e testes do ZEVANORY.

## Evidencia 3
Fonte: Neon - Serverless Postgres / Serverless Driver
Classe: A
Constatacao: Neon oferece Postgres serverless, driver adequado a Vercel e pooling para grande numero de conexoes.
Limite: desempenho e disponibilidade do nosso workload precisam ser medidos em producao.

## Veredito
Veredito: APROVADO COM RESTRICOES
Restricao: liberar ingestao publica somente apos schema aplicado e tres operacoes reais aprovadas em producao.
Criterio: migracao confirmada + primeiro INSERT + repeticao idempotente do mesmo event_id.
Kill-switch: qualquer erro de banco mantem whatsapp_enabled=false e bloqueia CTA comercial.
