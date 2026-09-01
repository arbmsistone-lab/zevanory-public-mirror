# WHATSAPP-ORIGIN-0001

Definicao: canal oficial da ZEVANORY.
Numero canonico do ativo Meta: 558892340423.
Exibicao humana observada no provedor: +55 88 9234-0423.

## Evidencia 1 - confirmacao atual do proprietario
Em 2026-09-01 o proprietario confirmou explicitamente que o WhatsApp anteriormente usado pela Giro passa a ser o WhatsApp oficial da ZEVANORY e determinou preservar a conta ja cadastrada na Meta.
Status: APROVADA.

## Evidencia 2 - ativo real no Meta Business
O Meta Business Suite do portfolio Zevanory exibiu o numero +55 88 9234-0423 na conta WhatsApp Business existente, com propriedade do portfolio Zevanory.
Status: APROVADA.

## Evidencia 3 - estado do provedor
O mesmo numero foi exibido pelo Meta Business como Conectado, classificacao de qualidade Alta; a alteracao de nome de exibicao para ZEVANORY foi enviada e ficou Em analise.
Status: APROVADA.

## Controles de runtime
`src/config.mjs` fixa `PROJECT.officialWhatsappE164` em 558892340423. O normalizador aceita E.164 brasileiro com numero local de oito ou nove digitos, e o matcher rejeita qualquer divergencia.
Os gates comerciais permanecem fail-closed; identidade do canal nao habilita vendas por si so.
Segredos, tokens e IDs privados do provedor nunca devem ser versionados.