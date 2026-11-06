# R133 | Correção do Illegal invocation no atendimento

Base: gh-pages 0a724e132cd438dd403d6fa2c873e2d36a4fd286 (produçao preservada). PR Draft isolado, nenhuma publicação.

## Causa e reprodução
- `atendimentoContext` armazenava referência nua de `globalThis.fetch` em `c.fetchImpl`; `resendSend` a chamava via `c.fetchImpl(...)`, alterando o receiver para o contexto.
- Cloudflare fetch não aceita esse receiver: `TypeError: Illegal invocation`, capturado como `resend_network` antes de alcançar o Resend.
- Regressão: o teste R133 substitui temporariamente `globalThis.fetch` por função nativa simulada que lança `Illegal invocation` se `this` não for `undefined` ou `globalThis`; o teste falha no SHA de base e passa com o wrapper. Injeção explícita de `fetchImpl` preservada.
- Diferença de produção: parâmetro padrão `fetchImpl = (...args) => globalThis.fetch(...args)`; sem mudança em credenciais, destino, banco, retry ou prazos.
- Página: protocolo exibido é comprovante de registro; e-mail não garantido como imediatamente entregue. Sem alterar contrato do backend.

## Varredura de binding e risco P04 (somente leitura)
| Módulo | Padrão | Diagnóstico / P04 |
| --- | --- | --- |
| `worker/atendimento.mjs` | `fetchImpl = globalThis.fetch` e `c.fetchImpl(...)` | AFETADO, corrigido apenas aqui |
| `worker/support-email-forward.mjs` | `c.fetchImpl` encaminhado a `resendCall(fetchImpl,...)` que chama função local | Receiver não é c; não demonstrado o mesmo defeito |
| `worker/site-chat.mjs` | `resendMailer(env, fetchImpl = globalThis.fetch)` chama parâmetro local | Receiver não é objeto; não demonstrado o mesmo defeito |
| `worker/voice-provider-router.mjs` | `fetchImpl` entregue como parâmetro a funções internas | Chamada local; não demonstrado |
| `worker/bluesky-publisher.mjs` | `fetchImpl = fetch` desestruturado e passado a `retryXrpc` | Chamada local; **não corrigir publicador**, risco P04 permanece travado |
| `worker/inbound-autonomy.mjs` | `fetchImpl = fetch` desestruturado e passado para `sendEmail` | Chamada local; não demonstrado, nenhuma ativação |
| `worker/voice-remote-tts.mjs` | `fetchImpl = fetch` desestruturado, chamada local | Não demonstrado; nenhuma ativação |

Esta varredura abrange os principais padrões identificados na busca do repositório e os módulos indicados na ordem. Não certifica ausência absoluta de todo receiver incorreto em código arbitrário ou módulos ainda não inspecionados.

## Gates e produção
- R132 registrou no Neon o protocolo `ZEV-20261106-DA2F6F3C54` com owner/customer pendentes, 1 tentativa cada, erro `resend_network`.
- Nenhuma promessa de entrega até que CI do PR esteja verde e, após merge/deploy autorizados, o cron retome a mesma linha e prove `owner_status='sent'`, `customer_status='sent'` e registros no Resend.
- Não fazer merge/deploy neste PR sem autorização literal específica pelo SHA; vendas continuam fechadas; custo zero obrigatório.
