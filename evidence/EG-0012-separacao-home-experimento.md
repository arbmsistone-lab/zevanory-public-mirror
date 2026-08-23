# EVIDENCE GATE

ID: EG-0012 / Separacao Home x Experimento
Decisao: manter / como identidade institucional ZEVANORY e executar EXP-0001 em /piloto.
Problema: impedir conflito entre identidade publica e jornada comercial mensuravel.

## Evidencia 1
Fonte: Vercel Routing/Rewrites - https://vercel.com/docs/routing
Classe: A
Constatacao: rewrites mapeiam uma URL publica para um arquivo/rota interna mantendo a URL exibida.
Limite: capacidade tecnica nao prova conversao.

## Evidencia 2
Fonte: Google Ads - Landing Page - https://support.google.com/google-ads/answer/14086?hl=pt-BR
Classe: A
Constatacao: experiencia de landing depende de relevancia, utilidade, navegacao e alinhamento com expectativa do clique.
Limite: orientacao para trafego de anuncios; nosso primeiro teste pode usar outras origens.

## Evidencia 3
Fonte: Optimizely Web Experimentation - URL targeting - https://support.optimizely.com/hc/en-us/articles/39073904618765-Target-URLs-to-choose-where-your-experiment-runs
Classe: B
Constatacao: experimentos podem ser restritos a URLs especificas, com teste de targeting e eventos por superficie.
Limite: fornecedor de experimentacao; nao prova desempenho comercial do ZEVANORY.

## Veredito
Veredito: APROVADO
Criterio: / institucional preservada; /piloto contem oferta+CTA+telemetria; ambas auditadas sem sobreposicao.
Kill-switch: qualquer vazamento do experimento para / ou perda de telemetria bloqueia deploy.
