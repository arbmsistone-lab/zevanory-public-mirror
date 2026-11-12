# Curadoria musical — PR #1029, NC15–17

A curadoria permanece separada do vídeo (#1028), desligada por variável e enabled/aprovações false. Sem merge, rótulo, dispatch, deploy, reabilitação ou chamada autenticada nesta entrega.

| NC | Correção | Teste e mutante |
|---|---|---|
| 15 | Cron diário com cinco campos; validação dos schedules tocados | cron com quatro campos é recusado |
| 16 | Estado e OGG/licença no KV, sem commit/push na gh-pages | promoção no KV; bytes verificados; hash divergente ignorado; corrupção recuperada; veto/limites/TTL; mutantes de push, hash e bloqueio indevido |
| 17 | BPM incerto não entra na distância; normalização pelas dimensões restantes; equivalência meia/dobra | pulso real sintético de 120 BPM, sinais sem pulso, confiança das sementes; mutante usando BPM da borda |

Estado: `zpc:shorts:v2:musica:estado`. Gravações: `zpc:shorts:v2:musica:faixa:<sha256>`, em envelope JSON com OGG base64 e registro completo da licença, até 600.000 bytes de áudio por faixa e seis promovidas vivas. A reserva de estado/cota mensal precede os blobs; falha de gravação não cria promoção fora do livro. Metadados, formato, tamanho e hash do conteúdo são conferidos antes do uso. O áudio temporário fica fora do checkout; o repositório permanece com Arpent e Funshine.

Ausência é legítima. Estado ilegível e erro de leitura usam a biblioteca aprovada do repositório; uma faixa inválida não é admitida. Os avisos são gravados no relatório existente quando o KV permite, e também passam pelo callback de diagnóstico. A curadoria não sobrescreve estado ilegível por um estado vazio: interrompe e avisa, preservando a contagem mensal anterior.

Veto continua entrando pelo perfil em PR normal. Na próxima execução a gravação é excluída; se a exclusão falhar, ela deixa de ser elegível e não renova seu TTL. Todo blob tem TTL de 30 dias, renovado apenas quando ativo, limitando a permanência de retiradas/vetadas. O relatório inclui a fonte original pública para ouvir as promovidas; não torna o KV público.

Arpent mediu 60 BPM na borda: `bpm_confiavel:false`. Funshine mediu aproximadamente 96,774 BPM, com confiança suficiente. O estimador também rejeita baixa autocorrelação, baixa proeminência e energia sem modulação. As outras medidas, a licença e o detector vocal continuam obrigatórios. A estimativa não é uma garantia de percepção musical.

Com três ou mais faixas, entre alternativas válidas que respeitam veto, última faixa e teto de participação, o tema tem prioridade real; outro tema só é usado quando não há alternativa válida daquele tema. Com duas, vale a alternância aceita pelo proprietário.

Os testes de mídia incluem dois MP4s adicionais: uma faixa verificada do KV e a recuperação de estado ilegível com música da base. O handoff de publicação é simulado localmente: não houve upload real nem prova de voz Gemini. O SHA, as saídas dos testes e o CI ficam na descrição do PR.
