# EG-0061 — YouTube OAuth + Resumable Upload

Status: APROVADO COM RESTRICOES
Data: 2026-09-01

## Evidencias independentes
1. Google YouTube Data API (fonte A): `videos.insert` exige OAuth com escopo de upload, aceita `video/*` e suporta envio de mídia; projetos API não verificados podem ter uploads restritos a `private` até auditoria do Google.
2. Google Resumable Upload Protocol (fonte A): iniciar sessão por POST, persistir `Location`, enviar mídia por PUT, consultar progresso com `Content-Range: bytes */TOTAL`, interpretar 308/Range e retomar após falha.
3. Vercel Functions Limits (fonte A): body de request/response é limitado a 4.5 MB e Functions não devem ser usadas como servidor intermediário de arquivos grandes; por isso o vídeo deve vir de URL HTTPS e ser transferido em chunks outbound, nunca recebido como body da API.
4. IETF RFC 6749 (fonte A): refresh tokens são credenciais confidenciais e devem permanecer protegidos em trânsito/armazenamento; nunca podem ser enviados à UI ou persistidos em telemetria pública.

## Decisao
Implementar adapter YouTube real com OAuth access token ou refresh-token server-side, sessão retomável persistida apenas no outbox privado, leitura de mídia por URL HTTPS com Range, chunks limitados por invocação e retomada por status do próprio Google.
