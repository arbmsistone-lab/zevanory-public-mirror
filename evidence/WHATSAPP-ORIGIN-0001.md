# WHATSAPP-ORIGIN-0001

Definicao: canal oficial do ZEVANORY.
Numero canonico E.164: 5588992340423.
Exibicao humana: +55 88 99234-0423.

## Operacao 1 - confirmacao do proprietario
Constatacao: o proprietario do projeto confirmou explicitamente este numero como oficial em 2026-08-23.
Status: APROVADA.

## Operacao 2 - definicao canonica imutavel
Constatacao: src/config.mjs define PROJECT.officialWhatsappE164 como 5588992340423 dentro de objeto congelado.
Status: APROVADA quando config.test.mjs passar.

## Operacao 3 - runtime integrado
Constatacao: o runtime somente habilita WhatsApp quando a configuracao normaliza e corresponde exatamente ao numero canonico; divergencia deve manter CTA bloqueado.
Status: APROVADA quando server-v2.integration.test.mjs passar.

Nenhum arquivo ou sistema externo ao ZEVANORY pode ser consultado para validar esta definicao.
Token de operador e segredo local e nunca deve ser versionado.
