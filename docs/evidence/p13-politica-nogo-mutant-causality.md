# Mutantes P13 (NO-GO / política única) — tabela de causalidade

Runner: teste "mutantes" em `tests/p13-politica-nogo.test.mjs` contra `scripts/sales_policy.py --audit`. Regra
Sol 128: cada mutante tem **primário** (1–3 regras `P13_FAIL`, regex ancorada, que testam diretamente a
mutação, por raciocínio) e secundário opcional `{re, why}`. KILLED exige status 1, `P13_AUDIT=FAIL`, stderr
vazio, ao menos uma linha `P13_FAIL` primária e toda outra linha primária ou secundária justificada; senão
INCONCLUSIVE. `validateMutantMap` recusa iniciar com secundário sem justificativa, 0 ou mais de 3 primários ou
mais de 4 regras sem `broad_reason`. O meta-teste do mesmo arquivo cobre só-secundário, falha não relacionada e
entrada sem justificativa.

| Mutante | Mutação | Primário (`P13_FAIL`) | Por que testa a regra | Secundário |
|---|---|---|---|---|
| M1 | produto mantém `href="/comprar/"` | `ia-na-pratica.html: href de checkout/assinatura (href="/comprar/) em modo fechado` | o gate de modo fechado procura href de checkout na página mutada | — |
| M1b | link absoluto para `/comprar/` | `solucoes.html: href de checkout/assinatura ("https://vendas.zevanory.api.br/comprar/) …` | idem, forma absoluta | — |
| M2 | Offer `InStock` no JSON-LD | `lucro-e-caixa.html: schema.org/InStock …` ou `… Offer paga em modo fechado (…InStock…)` | os dois verificadores de oferta paga leem o mesmo Offer inserido | — |
| M3 | termos com "após o pagamento" | `termos: formulacao divergente '7 dias após o pagamento'` | lista de formulações proibidas | — |
| M3b | produto troca a regra por "após a compra" | `vendas-na-pratica: falta '<regra 7 dias>'` ou `… formulacao divergente 'até 7 dias após a compra'` | a troca remove a regra exata e insere a formulação proibida | — |
| M4 | reembolso com "em até 2 dias úteis" | `reembolso: formulacao divergente 'em até 2 dias úteis'` | formulação proibida | — |
| M5 | produto sem 72 h | `combo-ia-vendas: falta 'link pessoal válido por 72 horas…'` | divulgação obrigatória ao lado da oferta | — |
| M7 | assinatura com `/assinar/` | `conteudo-pronto.html: href de checkout/assinatura (href="/assinar/) …` | gate de href em modo fechado | — |
| M7b | link `/hotmart/` | `ia-por-ramo.html: href de checkout/assinatura (href="/hotmart/) …` | idem | — |
| M7c | checkout `pay.hotmart.com` | `kit-afiliado.html: href de checkout/assinatura (href="https://pay.hotmart.com) …` | idem | — |
| M8 | calculadora com "garantia de 7 dias" | `calculadora-cmv: formulacao divergente 'garantia de 7 dias'` | formulação proibida | — |
| M8b | assinatura sem a regra dos 7 dias | `conteudo-pronto: falta '<regra 7 dias>'` | regra exata obrigatória | — |
| M6 | texto único alterado em termos | `termos: texto unico (Sol 079-P13) ausente ou alterado` | comparação exata do texto único | — |

Política: mutante SURVIVED ganha teste direto; o mapa nunca é ampliado para acomodar uma falha observada.
