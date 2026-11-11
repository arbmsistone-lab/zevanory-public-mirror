# Rodada 3 — implementação e provas

Base auditada: 896f79aa13f08ca68196abf8d3223252ab7ce428. Mesmo PR #1028, branch feat/shorts-padrao-v2.

## Critérios e controles negativos

| NC | Commit de código | Correção | Teste | Mutante |
|---|---|---|---|---|
| 07 | 8e8cd6e7117fe2f799308010abd61a0df17e78a5 | Cobertura por tarefa, exemplos de cálculo e seleção por histórico real | 180 dias × dica/calc/oferta; persistência e retomada idempotente; warning sem QC | Remover lição usada faz a simulação inteira falhar |
| 08 | 8e8cd6e7117fe2f799308010abd61a0df17e78a5 | Cena completa nos timestamps de fala, título por etapa e movimento interno | Limites comparados às palavras; filtro e texto serializado conferidos no render | Grade de 2,5 s e ritmo de 5 s recusados |
| 09 | 8e8cd6e7117fe2f799308010abd61a0df17e78a5 | Legenda em faixa escura separada | Contraste amostrado no MP4 a cada palavra | Fundo branco recusado por contraste; legenda fora da área segura recusada |
| 10 | 8e8cd6e7117fe2f799308010abd61a0df17e78a5 | Música perceptível, cama −23 LUFS e ducking mantido | Medidas dos stems e mix; limite superior da diferença voz/música | Cama −40 LUFS e remoção de sidechain recusadas |

A primeira execução do teste novo sobre a base reprovou por script_repeated_60d, antes de alterar os episódios. Os mutantes são cópias locais de código e não alteram produção.

## Cobertura

2026-11-12 a 2027-05-10, 180 dias consecutivos: dica 180/180, calc 180/180, oferta 180/180, total 540, zero falhas de cobertura, repetição ou roteiro inválido. Histórico acumulado entre os três slots. Saída completa: simulacao-180-dias.json.

## Limites

Os três vídeos offline usam voz de teste em forma de tom e timestamps explícitos. Provam render, geometria, cenas, arquivos e medição, mas não provam naturalidade Gemini nem alinhamento automático em fala real. O proprietário precisa ouvir as músicas/vozes e aprovar um vídeo com fala real. Sem merge, rótulo, dispatch, deploy, escrita remota de KV, segredo acessado ou reabilitação.

A cama de referência normalizada e a redução durante a fala foram medidas separadamente; trechos naturais sem fala devem ser conferidos também no preview com a voz escolhida. A cobertura simulada não equivale a uma publicação real nem a uma garantia além da janela testada.

## Resultado final executado

- Suíte geral: **1.559 PASS / 0 FAIL**, nos 171 arquivos de tests/*.test.mjs. Quatro lotes de 474, 394, 352 e 339 testes, para respeitar o limite de duração do terminal. A lista completa de arquivos está em lotes-testes.json; nenhuma exclusão de arquivo.
- Mídia: **9 PASS / 0 FAIL**, em três lotes disjuntos de 3 testes. Logs midia-lote-1.txt a midia-lote-3.txt.
- Total sem duplicar os testes direcionados: **1.568 PASS / 0 FAIL**.
- Direcionados (incluídos na suíte): 67 PASS / 0 FAIL.
- Simulação: **540/540**, zero falhas, antirrepetição de 30/60 dias intacta.
- git diff --check: PASS.

### Três renders definitivos

| Dia / slot | Vídeo | Quadros | Contraste mínimo | Voz acima da música | Ducking | QC |
|---|---:|---:|---:|---:|---:|---|
| 12/11 dica | 29 s | 870 | 14,707:1 | 17,952 dB | 11,110 dB | PASS |
| 13/11 calc | 29 s | 870 | 14,707:1 | 20,949 dB | 11,113 dB | PASS |
| 14/11 oferta | 29 s | 870 | 14,704:1 | 17,942 dB | 11,109 dB | PASS |

Inspeção visual: os três contatos foram abertos. Gancho sem corte lateral, sem glifos ausentes, títulos sem sobreposição, frases inteiras e legenda fora dos cartões. Um contato pode mostrar a mesma frase em quadros sucessivos: são amostras do realce dentro da mesma cena, não novos fragmentos.

[Previews técnicos](previews.html) · [Oito trilhas separadas](musicas.html). MP4, contato, ASS, roteiro, cenas e QC de cada dia estão nesta pasta.

### Achados adicionais corrigidos durante a execução

O render local revelou glifos de quebra de linha e um gancho de calculadora largo demais. O desenho por linha e a quebra pela medida real da fonte corrigiram ambos. Uma execução interrompida foi descartada, sem contar como prova. A concorrência de renders revelou também encerramento prematuro na faixa de vídeo causado pelo shortest do overlay final; ele foi substituído por repetição de EOF. O QC agora exige duração e quantidade de quadros da faixa de vídeo, além da duração do contêiner. A voz recebe padding somente no mixer para a música acompanhar o segundo final do CTA. As provas finais foram repetidas depois dessas correções.

### Estado de publicação

PR permanece DRAFT. O commit de evidências só acrescenta documentação e artefatos ao código 8e8cd6e. Sem merge, rótulo, dispatch, deploy ou reabilitação. As aprovações de voz, nível gratuito e preview continuam false no config. CI remoto não foi declarado aprovado com base nos testes locais.
