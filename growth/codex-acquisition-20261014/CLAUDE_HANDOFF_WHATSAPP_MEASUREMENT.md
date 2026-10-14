# Handoff operacional ao Claude — medição dos três guias de WhatsApp

**Solicitante:** frente Codex de aquisição C1–C3  
**Destinatário:** Claude, responsável pela frente operacional  
**Natureza:** documentação de dependência; nenhuma alteração operacional é implementada neste PR.

## Problema comprovado

O PR #815 mediu cobertura de destino e encontrou:

- campanha Fluxo de Caixa / Pix: 5/5 destinos rastreados;
- campanha WhatsApp / Clientes: 0/5 destinos rastreados.

Os cinco ativos da segunda campanha levam a três guias que existem e respondem no host correto, mas não fazem parte de `TRACKED_PAGES` no funil atual:

1. `/mensagem-para-cliente-que-sumiu`
2. `/como-cobrar-cliente-pelo-whatsapp`
3. `/como-mandar-orcamento-pelo-whatsapp`

Sem essa cobertura, `clean.campaigns.c3_whatsapp_clientes` não pode ser usado como total atribuído confiável e nenhuma comparação de visitas entre as duas campanhas está autorizada.

## Solicitação para PR operacional separado

Claude deve avaliar, em coordenação com o proprietário e sem misturar este PR editorial, uma alteração mínima no módulo canônico que define as páginas rastreadas. O PR operacional deve:

1. incluir exatamente os três slugs acima no registro de páginas rastreadas;
2. preservar o modelo agregado existente;
3. aceitar e normalizar apenas UTMs já previstas (`utm_source`, `utm_medium=organic`, `utm_campaign=c3_whatsapp_clientes`);
4. não capturar conteúdo de mensagem, nome, telefone, e-mail, IP bruto, cookie identificável ou outro dado pessoal;
5. manter os gates, workflows, checkout, pagamentos, credenciais e segredos inalterados;
6. adicionar testes positivos e negativos para os três destinos;
7. provar em ambiente autorizado que cada guia incrementa apenas a página e campanha esperadas;
8. demonstrar que rotas desconhecidas, campanhas inválidas e parâmetros extras continuam falhando de forma segura;
9. documentar rollback e impacto antes de qualquer deploy;
10. submeter SHA, CI e evidência agregada à auditoria independente.

## Critério de desbloqueio editorial

A campanha WhatsApp só poderá mudar de `blocked_0_of_5_until_operational_handoff` quando houver:

- PR operacional separado aprovado;
- CI verde;
- deploy pela esteira canônica autorizado pelo proprietário;
- readback dos três destinos sem PII;
- confirmação de que `c3_whatsapp_clientes` aparece na saída agregada correta.

A existência deste documento não é autorização para merge, deploy ou publicação. O Codex não modifica `worker/funnel.mjs`, workflows ou qualquer arquivo fora de `growth/**`.
