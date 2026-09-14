# ARBM Contador para SalÃµes â€” Runbook de Suporte

Status: CERTIFICADO PARA RELEASE COMERCIAL DO PRODUTO / VENDAS GLOBAIS BLOQUEADAS.
SKU: `ARBM-CONTADOR-SALOES`.
Fonte canÃ´nica: `arbmsistone-lab/arbm-mei`.
Release: `COMMERCIAL_RELEASE_1_0`.
SHA canÃ´nico: `20705d1620f640cee1b2a0aac97986d312c3e808`.
Worker: `https://arbm-mei-api.zevanory.workers.dev`.
Cloudflare Version ID: `6fa21b6b-d636-4726-a6fb-dd9d74605f6f`.

## Entrada e ativaÃ§Ã£o
1. Confirmar pagamento reconciliado somente quando o gate global permitir vendas.
2. Criar/validar tenant e conta proprietÃ¡ria.
3. Exigir aceite dos termos e polÃ­tica versionados.
4. Confirmar acesso, recuperaÃ§Ã£o e cÃ³digo de recuperaÃ§Ã£o.
5. Validar agenda, clientes e financeiro com dados de teste antes da entrega.

## Suporte de primeira resposta
- Canal: `suporte@zevanory.api.br`.
- Classificar: acesso, dados, agenda, financeiro, MEI, indisponibilidade ou privacidade.
- Nunca oferecer aconselhamento fiscal, contÃ¡bil ou jurÃ­dico como serviÃ§o regulado.
- NFS-e automÃ¡tica, Open Finance/Pix, WhatsApp, comissÃµes e estoque nÃ£o pertencem ao release 1.0.

## Incidentes e recuperaÃ§Ã£o
1. `/health` deve responder 200; `/ready` deve responder `ok:true`, `db:true` e `sales:false` enquanto o kill-switch global estiver ativo.
2. Se houver regressÃ£o, interromper promoÃ§Ã£o e voltar para a Ãºltima Version ID Cloudflare comprovada.
3. Preservar o D1 e usar o procedimento de backup/restore jÃ¡ certificado no produto antes de qualquer operaÃ§Ã£o destrutiva.
4. Para acesso perdido, usar o fluxo de recuperaÃ§Ã£o certificado; nÃ£o redefinir credenciais por chat.
5. Para solicitaÃ§Ã£o LGPD, usar exportaÃ§Ã£o/encerramento de conta e registrar a operaÃ§Ã£o.

## EvidÃªncia mÃ­nima para fechamento de ticket crÃ­tico
- horÃ¡rio e endpoint afetado;
- tenant impactado sem expor dados pessoais;
- cÃ³digo HTTP/erro;
- SHA/Version ID em produÃ§Ã£o;
- aÃ§Ã£o tomada e prova pÃ³s-correÃ§Ã£o;
- confirmaÃ§Ã£o de ausÃªncia de regressÃ£o nos E2E de gestÃ£o e ciclo comercial.

## Gate de venda
Este runbook nÃ£o autoriza venda. A ativaÃ§Ã£o comercial continua condicionada ao gate global `ZEVANORY_COMMERCIAL_SALES_LOCKED` e ao checkout oficial da ZEVANORY. Enquanto o gate global estiver fechado, suporte e onboarding podem ser testados, mas cobranÃ§a e provisionamento pago permanecem bloqueados.
