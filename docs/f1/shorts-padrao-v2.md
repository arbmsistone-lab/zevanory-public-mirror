# Shorts — padrão v2

Base gh-pages: a76ae60893b44f132094a048a2b1e8a26ad1f7ba. Branch própria feat/shorts-padrao-v2. Sem merge, rótulo, dispatch, deploy ou reativação. O workflow foi declarado pausado pelo proprietário; nenhuma operação de habilitação foi realizada. A implementação adiciona também uma trava de configuração false para publicação, independente do estado do workflow.

## Implementado

O caminho ativo do renderizador usa scripts/shorts-v2, sem trocar regras de preço, catálogo ou travas de venda. O plano v2 só oferece um kit se o modo Hotmart já estiver permitido. Dicas financeiras apontam ao kit Lucro & Caixa, vendas ao Vendas na Prática, tecnologia ao IA na Prática e dicas gerais ao Negócio de Verdade, sempre pela allowlist existente, sem alterá-la. Link contém utm_source=youtube, utm_medium=shorts, utm_campaign=<tema>. Vendas fechadas não viram vendas abertas por causa do vídeo. O código legado de planos/exportações permanece para regressões; o novo consumidor exige QC v2 100/100 antes de upload.

Roteiro de fala com 68–75 palavras de referência: pergunta concreta no gancho, frases de até 12 palavras, sem saudação, lista lida ou sigla soletrada. A dica específica do episódio substitui uma frase de referência quando respeita o limite e o filtro; texto longo/proibido reprova em vez de ser truncado em uma fala artificial. Direção do Gemini: conversa com amigo, energia no gancho, 150–170 ppm, sorriso na voz e pronúncia zê-va-nó-ri. O CTA é “Kit completo no link da descrição”. Preço, promessa de ganho, WhatsApp e Telegram são barrados.

O Gemini gratuito é o único sintetizador ativo. Sem fallback para Piper ou outra voz; a etapa que baixava Piper e o input que forçava voz local foram removidos. O modelo de API é gemini-2.5-flash-preview-tts, com voz fixa configurada. O uso diário é reservado antes da tentativa, inclusive em falha. A implementação não confirma billing nem cria credencial. Se o nível gratuito não estiver confirmado, bloqueia sem chamada. Referência oficial: https://ai.google.dev/gemini-api/docs/speech-generation .

Voz isolada: passa-alta 80 Hz, de-esser suave, compressor 2:1 e loudnorm −16 LUFS. QC mede ppm, silêncio interno máximo 0,9 s, clipping do PCM original e pico processado, voz −16 ±1 LUFS e duração final de 25–35 s. Não se limita a confiar na duração declarada pelo gerador.

As palavras são alinhadas localmente ao áudio real, em português, pelo stable-ts 2.19.1 / Whisper base; não se inventam timestamps uniformes para TTS. Sequência de palavras divergente, timestamps fora da duração ou fora de ordem reprovam. Legendas ASS grandes, grossas, contrastantes e com destaque na palavra falada, na área central segura (fora da coluna direita e dos 15% inferiores). O gancho aparece desde o primeiro frame; a marca só entra depois de dois segundos. As cenas alternam posições/cores em intervalos distribuídos entre dois e três segundos. CTA no final por três a quatro segundos; seu início é conferido contra o alinhamento real.

O mix mantém referência da música a −28 LUFS, ducking por sidechain, fade-in 0,5 s e fade-out 1,5 s; mix final −14 LUFS, alvo TP −1,5 dBTP. QC lê os stems e o MP4 codificado: música presente, atenuação medida ≥10 dB, diferença voz/música ≥12 dB, mix −14 ±1 LUFS e true peak ≤−1 dBTP. Falta de medição reprova. Bibliotecas, motor e ferramentas locais são gratuitos; não há serviço de alinhamento pago.

## Música e licença

Oito faixas FLAC locais (duas por clima), sintetizadas integralmente pelo gerador determinístico do repositório, sem samples ou gravação de terceiros:

| Tema | Clima | Faixas | BPM |
|---|---|---|---|
| IA/tecnologia | eletrônica leve | ia-1 / ia-2 | 108 |
| Vendas | animada/motivacional | vendas-1 / vendas-2 | 116 |
| Finanças/caixa | corporativa calma | financas-1 / financas-2 | 84 |
| Dicas gerais | lo-fi leve | dicas-1 / dicas-2 | 88 |

Cada registro em data/musica-licencas.json inclui arquivo, SHA-256, título, autor, URL do gerador, CC0-1.0, verificação em 11/11/2026, BPM, clima e temas. Ausência, licença inválida, arquivo faltante ou hash divergente bloqueiam. CC0 não exige crédito; o preview inclui a licença. Não há material de YouTube “no copyright” nem melodia de terceiro.

A seleção exclui a última faixa. O KV mantém recibo por episódio e projeção da última seleção. Erro de leitura nunca vira ausência. Projeção corrompida pode ser reconstruída somente a partir dos recibos legíveis dos últimos 30 dias; qualquer recibo ilegível ou ausência de evidência mantém o bloqueio. Preview lê o histórico mas não o escreve; a alternância é garantida para tentativas de produção serializadas pelo workflow, não para renders avulsos offline. Não há escrita no registro financeiro nem descarte de venda.

## Pendência real: comparação e aprovação da voz

**NÃO CONCLUÍDA: não foram geradas nem ouvidas quatro amostras Gemini reais.** Fazer isso exigiria usar a credencial existente em uma execução; esta tarefa proíbe acesso a segredos e dispatch. Os testes usam áudio sintético local e não comprovam naturalidade. Achird é apenas a referência já usada, não uma vencedora declarada.

Candidatas oficiais preparadas: Achird (Friendly), Puck (Upbeat), Kore (Firm) e Leda (Youthful). compare-voices.mjs usa exatamente a mesma frase, gera quatro WAV e um comparacao.json, não publica, não decide por score técnico qual soa mais humana e não altera a seleção. Também bloqueia enquanto nivel_gratuito_confirmado=false. Não foi executado. Não se propõe plano pago; qualquer decisão de gasto volta ao proprietário.

data/shorts-padrao-v2.json mantém comparacao_aprovada=false, nivel_gratuito_confirmado=false e publicacao_aprovada=false. Essas condições precisam ser resolvidas de forma auditada, com comparação real e motivo da escolha registrado, antes de um preview de marca e de reativação. Uma voz diferente da fixa reprova. Mesmo depois de escolher uma voz, publicação segue bloqueada até o proprietário aprovar o vídeo final. Esta entrega deve ser auditada como implementação técnica com pendência de voz, não como autorização de publicação.

## Artefatos e verificação

O dry-run futuro conserva short-preview com MP4, qc.json, roteiro, faixa, licença e alinhamento. O upload de diagnóstico roda mesmo se o gate posterior falhar; falta total de arquivos reprova. O upload YouTube já marca containsSyntheticMedia=true e continua assim: usa-se divulgação conservadora porque há voz sintética realista. Não se alega que todas as animações institucionais são obrigadas à marcação. Referência: https://developers.google.com/youtube/v3/docs/videos/insert .

24 testes portáteis novos e três provas adicionais de mídia local: mix/ducking real com FFmpeg, mutante que retira o sidechain e render completo de 28 segundos com voz artificial de teste (não Gemini e não voz de marca). Foram preservados os testes antigos, incluindo seus mutantes; o carregamento do renderizador é adiado até a renderização, preservando o isolamento dos espelhos dos laboratórios existentes. Os oito mutantes obrigatórios e os adicionais morrem por asserção, sem contar falha de importação como detecção. O alinhador real não foi executado: o ensaio de mídia usa timestamps conhecidos do sinal sintético que ele próprio gera; a comparação real deverá exercitar o alinhador.

CI de mídia separado roda em pull_request, sem ambiente de produção, segredo ou TTS externo. A suíte portátil não exige FFmpeg no Windows; a prova real roda no job Linux com ferramentas instaladas. Manifesto ordenado, manifest-tests, preço, DDL e tests/guards devem passar antes do push.

Reservados tocados: .github/workflows/youtube-autonomous-short.yml e .github/workflows/shorts-v2-checks.yml. Permitidos pelo documento do proprietário; merge exige owner-approved:<12 hex do SHA>. Nenhum rótulo aplicado. Nenhum outro PR alterado.
