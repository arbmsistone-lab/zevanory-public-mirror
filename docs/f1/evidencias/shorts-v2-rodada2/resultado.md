# Resultado local — rodada 2 do #1028

Base de trabalho: 3a6fa5c8afabcae4d9c47afc18d0f286689446bb. O commit desta rodada é informado na descrição do PR; este documento não tenta conter seu próprio hash.

| Verificação | Resultado |
|---|---|
| Suíte portátil completa | 1544/1544; 0 falhas/pulos/cancelamentos/todo |
| Manifesto exato por arquivo | PASS; esperado 1544 |
| Testes adicionais da rodada 2 | 14/14 (incluídos nos 1544) |
| Guardas de portabilidade + reteste da rodada 2 | 17/17; guarda isolado 3/3 |
| Provas de mídia Linux | 7/7 |
| Verificador do manifesto | 14/14 |
| Preços | 12/12 |
| DDL | 29/29 selftests; varredura PASS |
| Laboratório sales-lock anterior | 34/34 mutantes mortos |
| Novos mutantes causais da rodada 2 | 8/8; 5 portáteis + 3 alterando o render |
| Biblioteca musical entregue | 8 gravações, 4247254 bytes, todas com 36 s |
| Workflow YouTube, consulta somente leitura | disabled_manually; id 381237682 |

## Render offline inspecionado

O ensaio final usa o episódio **pet shop / pacote mensal de banho** do calendário real. Sinal de voz sintético local e alinhamento conhecido, sem credencial, TTS externo ou gravação em KV. Gera MP4, contato de cenas, ASS, filtro, roteiro, licença e QC. Não certifica voz Gemini ou o alinhador em uma fala real.

- Duração do MP4: 29.00 s; velocidade do sinal: 150.00 palavras/min.
- Gancho: 96 px, de 0.00 a 4.02 s; primeira frase termina em 4.02 s.
- Limites da legenda medidos: x=233.71 a 766.29; base máxima=1466.50; fonte mínima=86.
- Cortes encontrados no MP4: 11; intervalos 2.400–2.433 s.
- Ducking medido: 14.33 dB; separação voz/música: 26.17 dB.
- Voz isolada: -16.00 LUFS; mix final -14.00 LUFS; true peak -7.90 dBTP.

O limiar do compressor foi ajustado de 0,005 para 0,04: a atenuação medida continua acima de 10 dB sem reduzir a música em aproximadamente 30 dB durante todo o sinal de voz de teste. O mutante que retira o compressor continua morto.

## Matriz de resposta

| NC | Commit | Teste | Mutante | Resultado local |
|---|---|---|---|---|
| 01 | commit desta rodada | campos de licença/hash; 8 arquivos reais, duração e 6 MB | aceitar evidência ausente | PASS técnico; curadoria auditiva a confirmar |
| 02 | commit desta rodada | 30 dias × dica/oferta = 60 roteiros; repetição e recuperação | roteiro fixo; guarda desligada | PASS |
| 03 | commit desta rodada | ASS/fonte/filtro e detector do MP4 | y1800; cenas de 5 s no render | PASS |
| 04 | commit desta rodada | template, Inter, zoom, progresso, kit e contato | gancho real de 58 px | PASS |
| 05 | commit desta rodada | matriz 4×2; protocolos e identidade do modelo | modelo divergente aceito | código PASS; amostras reais pendentes |
| 06 | commit desta rodada | SKU, palavra inteira, farmácia/diária e ambiguidade | IA por substring | PASS |

## Pendências preservadas

Sem PASS editorial ou autorização de publicação: falta reauditoria independente, audição das gravações no vídeo, confirmação do nível gratuito, geração/escuta das oito amostras reais e aprovação do preview pelo proprietário. Não foram gerados WAVs Gemini nesta rodada. A configuração de referência 3.8/Achird não representa uma escolha auditiva aprovada.

A falha do T1 por sessão não cadastrada não foi corrigida nem contornada. Nenhuma alteração em ops/executor.json. O estado remoto de CI deve ser consultado no SHA definitivo, sem confundir testes locais com os checks do GitHub.

Para reter a prévia local durante a reauditoria:

```bash
KEEP_SHORT_PREVIEW=1 node --test tests/media/shorts-v2-media.test.mjs
```

A linha PREVIEW_PATH informa a pasta temporária; os outros renders mutantes são apagados. O ensaio positivo mantém todos os artefatos para inspeção independente.
