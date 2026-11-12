# Shorts — vídeo separado da curadoria

O vídeo permanece no PR #1028, com Arpent/Funshine. A curadoria é um recurso posterior no PR DRAFT #1029, desativado até revisão e autorização.

- [NC15–17, estado no KV, limites, recuperação e BPM](shorts-curadoria-musical-rodada5.md).
- [Histórico da rodada 4b](evidencias/shorts-v2-rodada4/resultado.md).
- [Medições das sementes](evidencias/shorts-v2-rodada4/medidas-aprovadas.json).

Com duas faixas, a seleção alterna sem repetir. Com três ou mais, o tema tem prioridade entre alternativas válidas; só há fallback para outro tema se nenhuma alternativa daquele tema respeitar as demais regras.

O repositório só contém as duas gravações aprovadas. Descoberta e desempenho persistem no KV; o workflow tem contents: read, sem commit ou push. Previews técnicos ficam em artefato do Actions. Nenhuma automação foi ligada nesta entrega.

As prévias técnicas e músicas ficam no artefato `shorts-v2-review` do Actions, fora do repositório. São ensaios com voz sintética local; não certificam a voz Gemini. Comparação de oito amostras, plano gratuito e aprovação de vídeo com voz real continuam pendentes. Publicação permanece desligada.

Sem merge, rótulo, dispatch, deploy ou reabilitação nesta entrega. Ideias novas exigem PR novo.

## Rodada 3 — preparação executável sem publicação
O novo shorts-v2-amostras.yml fica disponível normalmente após merge na branch padrão gh-pages. Não depende do youtube-autonomous-short.yml, que permanece desabilitado. Nenhum workflow foi habilitado/despachado nesta entrega. A branch candidata não é um caminho de execução com segredos; os testes são offline.

Sequência: (1) auditorias e merge autorizado; (2) autorização do proprietário no chat para dispatch modo amostras, confirmando nível gratuito para a execução; (3) escutar oito WAVs e escolher voz/modelo por PR, aprovando comparacao_aprovada e a evidência de nivel_gratuito_confirmado separadamente; (4) dispatch autorizado modo previa; (5) proprietário assiste e aprova o vídeo real; (6) PR separado com publicacao_aprovada; (7) reabilitação autorizada do publicador. Amostras não aprovam comparação, gratuidade permanente nem publicação. A confirmação transitória não altera o JSON.

Jobs recebem somente GEMINI_API_KEY, sem YouTube/Meta/Cloudflare/KV. Guardam arquivos apenas nos artefatos do Actions, sem upload de vídeo a plataforma ou escrita de aprovações. Prévia usa renderV2 real, voz/modelo do JSON, preview:true e estado local vazio de leitura que recusa qualquer escrita. Exige comparacao_aprovada e nivel_gratuito_confirmado no JSON; publicacao_aprovada permanece independente e pode continuar false. Erro de faturamento, cota ou permissão do Gemini interrompe sem retry/fallback pelo adaptador auditado. O voice_samples do publicador desabilitado é legado; usar o workflow separado.
