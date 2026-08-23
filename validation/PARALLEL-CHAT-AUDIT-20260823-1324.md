# Auditoria do trabalho paralelo — 2026-08-23 13:24

Escopo: revisar o chat/agente concorrente sem sobrescrever a frente ativa.

## Confirmado correto
- Repositorio ativo: C:\Sistemas\ZEVANORY.
- Home institucional separada do piloto comercial.
- / -> public/index.html; /piloto -> public/piloto.html.
- Identity guard ativo.
- Suite local: 32/32 PASS.
- Auditoria 3X: 27/27 unidades aprovadas.
- Prova operacional em zevanory-site.vercel.app: PASS.
- Deploy Vercel atual: READY.

## Erros/bloqueios reais encontrados
1. zevanory.api.br NAO esta associado ao projeto Vercel.
   - Vercel project domains lista apenas *.vercel.app.
   - `vercel domains add zevanory.api.br zevanory-site` retorna 403 domain_not_owned.
   - `vercel domains inspect zevanory.api.br` retorna sem acesso ao dominio na conta.
   - DNS publico continua sem endereco funcional/TXT de verificacao.

2. Git do ZEVANORY nao possui remote configurado.
   - HEAD local: 3f1643d2e59691ebfe26918e2fd67992f49e514e.
   - O commit existe localmente, mas nao ha origin para push/sincronizacao.

## Frente concorrente observada
- Outro chat iniciou EG-0013 para provedor de pagamento Asaas.
- Nao editar esse arquivo enquanto a frente estiver ativa.
- A premissa tecnica atual esta adequada: webhook autenticado + reconciliacao API antes de evento financeiro.

## Regra de fechamento
Nao declarar dominio oficial nem sincronizacao Git como concluidos ate prova publica e remota.

## Novos bloqueios encontrados — 13:36
3. Integridade do pedido ainda incompleta.
   - O webhook valida formato `ZEVANORY:EXP-0001:<uuid>`, valor, status e consulta o Asaas.
   - Ainda nao existe tabela/registro interno de pedido ou checkout validado pelo webhook.
   - Antes de contar venda, o UUID deve existir em uma ordem criada pelo ZEVANORY e corresponder a oferta/experimento/valor.

4. Estorno parcial ainda nao coberto.
   - Asaas suporta `PAYMENT_PARTIALLY_REFUNDED`, inclusive multiplos estornos parciais em Pix.
   - O codigo atual aceita apenas `PAYMENT_REFUNDED`.
   - Publicar assim pode superestimar receita liquida apos estorno parcial.

Regra: manter integracao em Sandbox/bloqueada para producao ate ambos os pontos terem teste e reconciliacao deterministica.
