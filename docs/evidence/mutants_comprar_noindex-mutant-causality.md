# Mutantes `/comprar/` noindex — tabela de causalidade

Runner: `scripts/ci/mutants_comprar_noindex.py`. Suíte: `tests/comprar-noindex.test.mjs`. Regra Sol 128:
o rótulo **primário** vem do raciocínio sobre a mutação (a asserção que testa diretamente a regra mutada),
nunca de quais testes falharam. KILLED exige ao menos uma falha de asserção com rótulo primário dentro do
bloco `not ok`; toda outra falha precisa ser primária ou secundária justificada, senão INCONCLUSIVE. O runner
recusa iniciar (exit 4) se um secundário não tiver justificativa, se houver 0 ou mais de 3 primários, ou se um
mutante listar mais de 4 asserções sem `broad_reason`. Meta-testes: `tests/test_mutants_comprar_classifier.py`.

| Mutante | Regra mutada | Primário | Por que o primário testa a regra | Secundário (justificativa) |
|---|---|---|---|---|
| M1 | X-Robots-Tag no redirect 303 | `[x-robots-tag]` | a asserção do cabeçalho roda em cada estado do fluxo, inclusive o 303 | — |
| M2 | X-Robots-Tag no 404 | `[x-robots-tag]` | idem, no estado 404 de SKU desconhecido | — |
| M3 | valor `noindex, nofollow` | `[x-robots-tag]` | a asserção compara o valor exato do cabeçalho | — |
| M4 | `no-store` no 405 | `[cache-control]` | a asserção de `cache-control` roda no 405 | — |
| M5 | meta robots no HTML | `[meta]` | a asserção exige exatamente uma meta `noindex,nofollow` | — |
| M6 | meta robots mantida como `noindex` | `[meta]` | idem, falha com a meta original sem `nofollow` | — |
| M7 | caminhos não-SKU sob `/comprar` | `[x-robots-tag]` | o teste de caminhos desconhecidos/aninhados exige o cabeçalho; sem a rota caem nos assets sem ele | — |
| M8 | exceção dentro do fluxo | `[exception]` | o teste de exceção exige 503 com cabeçalhos em vez de lançar | — |
| M9 | `/COMPRAR` maiúsculo (flag `i`) | `[x-robots-tag]` | o teste de caminhos exige o cabeçalho em `/COMPRAR/...` | `[alias]`: o alias `/%43OMPRAR` decodifica para `/COMPRAR`, que a regex sem `i` deixa de casar; o teste de aliases falha no status antes do cabeçalho |
| M10 | sitemap de vendas sem `/comprar/` | `[sitemap:sales-public/sitemap.xml]` | asserção por arquivo de sitemap | — |
| M11 | sitemap apex sem `/comprar/` | `[sitemap:sitemap.xml]` | idem | — |
| M12 | robots.txt de vendas sem Disallow | `[robots:sales-public/robots.txt]` | asserção por arquivo de robots | — |
| M13 | robots.txt do overlay sem Disallow curinga | `[robots:sales-overlay/robots.txt]` | idem | — |
| M14 | canonical nunca aponta para `/comprar/` | `[canonical]` | asserção de link canonical/alternate por página | — |
| M15 | decodificação do caminho antes de casar | `[alias]` | o teste de aliases percent-encoded exige o mesmo fluxo | — |
| M16 | aliases multi-codificados | `[double]` | o teste de dupla codificação exige 404 com cabeçalhos | — |
| M17 | hex maiúsculo decodificado | `[alias]` | aliases como `%43` exigem o mesmo fluxo | — |
| M18 | alias duplamente codificado não roteável | `[double]` | o teste exige que não chegue ao fluxo de compra | — |
| M19 | wa.me no 404 de alias | `[whatsapp]` | oráculo cruzado do corpo de `/comprar` | — |
| M20 | número banido mascarado no 404 de SKU | `[whatsapp]` | idem | — |
| M21 | frase de canal WhatsApp no 503 | `[whatsapp]` | idem | — |

Política: se um mutante sair SURVIVED, acrescenta-se um teste direto para ele; a lista de rótulos nunca é
ampliada para acomodar uma falha observada.
