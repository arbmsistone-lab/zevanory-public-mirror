# Shorts v2 — escopo congelado do PR #1028

Este PR entrega somente o vídeo: roteiro por episódio com histórico, identidade visual, legendas alinhadas, mixagem e QC medidos no arquivo final. As correções de manifesto, resumos de evidência e pacote de prévias fora do site permanecem.

A biblioteca fixa contém apenas **Arpent** e **Funshine**, aprovadas pelo proprietário, com licença CC0 comprovada e hashes conferidos. A seleção não repete a última música; com duas faixas, elas alternam. O tema só decide a primeira escolha, quando ainda não há faixa anterior. Histórico de publicação e reserva de render continuam separados, inclusive em retentativas.

A curadoria automática, seu workflow, perfil, estado, análise, relatório e testes da rodada 4 foram separados para `feat/shorts-curadoria-musical`, em PR DRAFT dependente desta entrega. Nenhuma correção da rodada 5 foi incorporada: seus defeitos continuam pendentes no PR separado. Só deverá entrar depois dos Shorts no ar, com nova auditoria e autorização.

As prévias técnicas e músicas ficam no artefato `shorts-v2-review` do Actions, fora do repositório. São ensaios com voz sintética local; não certificam a voz Gemini. Comparação de oito amostras, plano gratuito e aprovação de vídeo com voz real continuam pendentes. Publicação permanece desligada.

Sem merge, rótulo, dispatch, deploy ou reabilitação nesta entrega. Ideias novas exigem PR novo.

## Rodada 3 — preparação executável sem publicação
O novo shorts-v2-amostras.yml fica disponível normalmente após merge na branch padrão gh-pages. Não depende do youtube-autonomous-short.yml, que permanece desabilitado. Nenhum workflow foi habilitado/despachado nesta entrega. A branch candidata não é um caminho de execução com segredos; os testes são offline.

Sequência: (1) auditorias e merge autorizado; (2) autorização do proprietário no chat para dispatch modo amostras, confirmando nível gratuito para a execução; (3) escutar oito WAVs e escolher voz/modelo por PR, aprovando comparacao_aprovada e a evidência de nivel_gratuito_confirmado separadamente; (4) dispatch autorizado modo previa; (5) proprietário assiste e aprova o vídeo real; (6) PR separado com publicacao_aprovada; (7) reabilitação autorizada do publicador. Amostras não aprovam comparação, gratuidade permanente nem publicação. A confirmação transitória não altera o JSON.

Jobs recebem somente GEMINI_API_KEY, sem YouTube/Meta/Cloudflare/KV. Guardam arquivos apenas nos artefatos do Actions, sem upload de vídeo a plataforma ou escrita de aprovações. Prévia usa renderV2 real, voz/modelo do JSON, preview:true e estado local vazio de leitura que recusa qualquer escrita. Exige comparacao_aprovada e nivel_gratuito_confirmado no JSON; publicacao_aprovada permanece independente e pode continuar false. Erro de faturamento, cota ou permissão do Gemini interrompe sem retry/fallback pelo adaptador auditado. O voice_samples do publicador desabilitado é legado; usar o workflow separado.
