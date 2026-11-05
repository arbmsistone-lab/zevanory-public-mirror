# R111 | Guard de segredos do publicador ZPC (CANDIDATO, sem deploy)

**Estado:** PR Draft. O `t2-exact-control-worker-promotion` permanece disabled_manually. Não foi reativado.

## Risco e mitigação
O reconciliador T2 (agendado em intervalos de 15 minutos quando ativo) detecta divergências de linhagem e despacha `zpc-control-worker-deploy.yml`. Este último executa `wrangler deploy`, caminho distinto do corte supervisionado pelo Claude com `versions upload` + `versions deploy`.

No workflow candidato foi incluído antes da etapa de `wrangler deploy`:
1. Conferência estática da presença do modo forte no SHA do Edge (`ADMIN_AUTH_MODE` no Worker e `passphraseLogin` no backend).
2. GET **somente leitura** `/accounts/{account_id}/workers/scripts/zevanory-product-control-portable/secrets` usando o token já disponível no ambiente do job.
3. Parser estrito verifica exclusivamente os nomes `ADMIN_AUTH_MODE`, `ADMIN_PASSPHRASE`, `SESSION_SIGNING_KEY`. Qualquer nome ausente, API indisponível, payload inválido ou autorização insuficiente: FAIL-CLOSED, antes do deploy. Os valores do payload NÃO são impressos nem utilizados.
4. Depois do `wrangler deploy`, a conferência de nomes é repetida antes dos readbacks existentes. Falha posterior aciona alarme, mas **não é reversão automática**.

**Limite da prova:** a presença de um nome não confirma o valor, nem garante que o código selecionou `ADMIN_AUTH_MODE=passphrase`. Um GET pré-deploy também não demonstra preservação de secrets pelo comando `wrangler deploy`. A prova exigida antes de reativar T2 inclui sandbox descartável com mesma versão Wrangler/configuração e secrets fictícios, version-list antes/depois, login simulado e readbacks do modo forte. Não executar sandbox com credenciais reais.

## Portões de liberação
- PR Draft, CI verde em SHA exato, auditoria independente Claude, configuração protegida, mesmo sha base/target.
- Confirmação da cadeia Edge main já integrada após #217, sem PIN/diagnóstico.
- Prova em sandbox de preservação de segredos; se versão nova mudar de modo, NO-GO.
- Eventual reativação de T2 exige **outra autorização específica do proprietário**, com workflow já corrigido.
- Os 3 workflows de PIN continuam desativados. Nenhum robô recebe `ADMIN_PASSPHRASE`.
- Sem cloudflare Access até após primeira venda; Turnstile tem PR independente, também sem deploy.

## Reversão
Se CI ou auditoria falhar, congelar o PR e manter T2 desativado. Não reverter para PIN, não usar `allow_backwards` sem frase nova. Em falha real após deploy, a recuperação exige autoridade do proprietário, snapshot e combinação consistente de Worker+frontend+segredos, sem imprimir segredos.
