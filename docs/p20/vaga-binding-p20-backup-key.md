# P20 — Vaga de binding para `P20_BACKUP_KEY`: remover `VOICE_TTS_FREE_ONLY` do Worker `zevanory`

**Status:** PROPOSTA. Nenhuma ação em produção foi feita. Quem executa é o proprietário, depois do merge do PR da
cifragem (`docs/p20/cifragem-backup.md`).

## Por que

O deploy central só passa se o total de nomes de segredos e vars do Worker `zevanory` for no máximo 60
(`scripts/deploy/check-binding-budget.py`). Esse total inclui `CHANNEL_CREDENTIALS_JSON`. A cifragem do backup precisa de
**um** segredo novo, `P20_BACKUP_KEY`. A proposta é liberar a vaga apagando o segredo `VOICE_TTS_FREE_ONLY`, porque
ausente ele produz o **mesmo** efeito de proteção (fail-closed). O valor 60 de partida é a premissa da coordenação. Ele
precisa ser confirmado no último log `BINDING_BUDGET_PASS planned=N` do `central-production-deploy`, porque este
repositório não lê o estado vivo.

| Passo | `planned` |
|---|---|
| hoje (premissa) | 60 |
| 1) apagar `VOICE_TTS_FREE_ONLY` | 59 |
| 2) cadastrar `P20_BACKUP_KEY` | 60 |
| 3) deploy | 60 (`BINDING_BUDGET_PASS`, `≤ 60`) |

## O que a variável faz

O código só a lê em comparações `=== "true"`. Ausente ou com qualquer outro valor, o Worker se comporta como `"false"`.

- `worker/voice-provider-router.mjs`:
  - `ttsBytesWithFailover`: sem `"true"`, lança `voice_tts_zero_spend_guard_required` **antes** de qualquer rede.
  - `chainFromEnv`: com `"true"`, filtra a cadeia para provedores grátis; sem ele, a cadeia não é filtrada, mas a síntese
    já foi recusada acima.
  - `voiceProviderStatus.zero_spend_enforced`: só exibição.

Ou seja, sem a variável **nenhuma** voz é sintetizada e nenhum provedor (pago ou grátis) é chamado. A proteção de custo
zero continua valendo, por recusa.

Prova (rodada em 07/11/2026 neste worktree):

```
$ node --input-type=module -e '…ttsBytesWithFailover("Olá", {GEMINI_API_KEY, GEMINI_FREE_TIER_CONFIRMED:"true", VOICE_TTS_PROVIDER_CHAIN:"gemini"}, fetchQueConta)…'
sem_variavel: voice_tts_zero_spend_guard_required chamadas_de_rede=0
status.zero_spend_enforced=false
```

Testes existentes que fixam a recusa (eles usam `"false"`, que o código trata igual a ausente):

- `tests/circuits-adversarial.test.mjs:461`, teste "G4 ambas as rotas caídas → erro explícito; sem guarda zero-custo →
  recusa sem rede". A linha 468 confere `voice_tts_zero_spend_guard_required` e `g.calls` vazio. Resultado: 31/31 pass.
- `scripts/voice_router_adversarial.mjs:128-130`, bloco "ZERO_SPEND guard itself is mandatory" (`VOICE_PAID_FALLBACK_FALSE=PASS`).
  Termina com `REGRESSION_GATES=PASS`, rc 0.

## Todos os consumidores (`git grep -n VOICE_TTS_FREE_ONLY`)

| Onde | Quem alcança | Efeito sem a variável |
|---|---|---|
| `worker/voice-provider-router.mjs:37,297,314` | todos os chamadores abaixo | síntese recusada sem rede; status mostra `zero_spend_enforced:false` |
| `worker/cloudflare-worker.compat.mjs:580` `/api/internal/voice-eval/run` (`diag.freeOnly` e `fallbackSynth`) | **interna**: só POST com token de operador (`verifyOperatorToken`) | a voz principal (`synthesizeVoice`) não lê a variável; o **fallback** passa a falhar. Ver "voice-eval semanal" abaixo |
| `worker/cloudflare-worker.compat.mjs:417` (status do canal de resposta instantânea do WhatsApp) | leitura de status | `voice_free_only:false` (só exibição; WhatsApp `disabled_permanent`) |
| `worker/voice-naturality-study.mjs:146` `/api/voice-study/sample` (roteado em `cloudflare-worker.compat.mjs:445`) | **pública, sem token** (portal de estudo cego de naturalidade da voz) | a amostra de áudio falha (`voice_tts_zero_spend_guard_required`, sem rede e sem custo); página, sessão e avaliação continuam respondendo |
| `worker/cloudflare-worker.recovered.mjs:13048,13065` `ttsBytesFromRuntime` → `/api/voice/probe` (GET) e resposta de voz do WhatsApp (`:13125`) | probe: GET público de diagnóstico; WhatsApp: canal aposentado | probe responde 503 `{ok:false,error:"voice_tts_zero_spend_guard_required"}`; WhatsApp `disabled_permanent` (o roteador compat nunca carrega credencial do WhatsApp; `voice_support_gate.py` → `WHATSAPP_RETIRED_ONBOARDING_GATE=PASS`) |
| `worker/cloudflare-worker.recovered.mjs:18553` `/api/voice/status`, `worker/voice-final-closure.mjs:19` | leitura de status | `zero_spend_enforced:false` (exibição) |
| `scripts/zero_cost_guard.py:32`, `scripts/voice_support_gate.py:39,85` | CI (estático) | continuam passando (abaixo) |
| `.github/workflows/voice-zero-spend-enable.yml`, `voice-gemini-production-provision.yml`, `voice-gemini-auth-key-probe.yml` | só `workflow_dispatch` | **gravam** `VOICE_TTS_FREE_ONLY` de novo. Ver "Cuidados" |
| `scripts/voice_router_adversarial.mjs`, `scripts/whatsapp_*_test.mjs`, `tests/circuits-adversarial.test.mjs` | testes com env sintético | nenhum (não leem o Worker) |
| `docs/binding-audit-zevanory.md:59` | documentação | passa a ser "removida (vaga P20)" quando o proprietário executar |

Fora da lista: nenhum destes lê a variável (`git grep VOICE_TTS` = 0 ocorrências).

- **Chat do site:** `worker/site-chat.mjs`, `worker/r120-chat-public.mjs`, `worker/r120-chat-institutional.mjs`.
- **Atendimento:** `worker/atendimento*.mjs`.
- **Entrega Hotmart:** `worker/*hotmart*.mjs`.
- **Vendas:** `sales-worker.mjs`, `worker/sales-public-worker.mjs`.
- **Backup:** `worker/data-backup.mjs`, `worker/backup-crypto.mjs`.

## Onde a premissa da coordenação não se confirmou (registro honesto)

1. **`voice-naturality-study` não é rota interna com token.** `/voice-study` e `/api/voice-study/*` são públicas, com
   participante identificado por cookie e impressão digital, sem token de operador. O efeito é que o **portal público de
   estudo de naturalidade** deixa de tocar a amostra de áudio. Não é superfície de compra, entrega, chat ou atendimento,
   e não há custo nem chamada de rede. Mas é uma regressão visível nesse portal, até que a voz seja religada. O estudo
   depende de 100 avaliadores humanos (`unique_evaluators>=100`) e hoje não tem prazo comercial. Para manter o portal
   tocando, a alternativa é compactar outra var em vez de apagar este segredo.
2. **`/api/voice/probe`** é GET público de diagnóstico. Passa a responder 503 com o código explícito.
3. **voice-eval semanal** (`.github/workflows/voice-eval.yml`, cron `30 12 * * 0`): `runVoiceEval` exige o fallback
   (`worker/voice-eval.mjs:92-99`). Sem a variável, o relatório registra `failures:["fallback_voice"]`, a rota responde
   500 e o workflow fica **vermelho toda semana**. É monitoramento interno, sem efeito em cliente. O proprietário deve
   aceitar o vermelho ou desligar o agendamento por decisão própria; este PR não altera isso.

## Gates de CI sem a variável

Os dois gates são estáticos (leem o código e o gerador do deploy, nunca o segredo vivo). Por isso não mudam com a remoção:

```
$ python3 scripts/zero_cost_guard.py
ZERO_COST_GUARD=PASS
$ python3 scripts/voice_support_gate.py
VOICE_ENGINE_STATIC_GATE=PASS … VOICE_PRODUCTION_FAIL_CLOSED_ZERO_SPEND_CONFIG_GATE=PASS … WHATSAPP_RETIRED_ONBOARDING_GATE=PASS … VOICE_CANONICAL_FINAL_CLOSURE_GATE=PASS   (rc 0)
```

`voice_support_gate.py:85` exige que o gerador do deploy **não** grave `VOICE_TTS_FREE_ONLY` como var. Isso continua
verdadeiro: a remoção é do segredo, fora do deploy.

## Ordem operacional (proprietário; nada disto foi feito)

1. **Apagar** o segredo: `npx wrangler secret delete VOICE_TTS_FREE_ONLY --name zevanory` (conta `1b264158…`), ou pelo
   painel (Worker `zevanory` → Configurações → Variáveis e segredos). O Cloudflare publica uma versão nova
   ("Secret Change"). A partir daí a voz fica recusada (fail-closed), como descrito acima.
2. **Cadastrar** `P20_BACKUP_KEY`: passos 2 a 4 de `docs/p20/cifragem-backup.md`.
3. **Deploy:** o próximo `central-production-deploy` deve imprimir `BINDING_BUDGET_PASS planned=60`. Os segredos
   sobrevivem ao deploy (`--keep-vars`).

A ordem importa: cadastrar antes de apagar levaria a 61 e bloquearia o deploy (`BINDING_BUDGET_EXCEEDED`).

## Cuidados

- **Não rode** `voice-zero-spend-enable.yml`, `voice-gemini-production-provision.yml` nem `voice-gemini-auth-key-probe.yml`
  depois da remoção. Eles regravam `VOICE_TTS_FREE_ONLY` e o orçamento voltaria a 61, o que bloqueia o deploy.
- **Para religar a voz no futuro:** primeiro libere outra vaga (compactação no `ZEVANORY_RUNTIME_CONFIG`,
  `tests/test_binding_budget_compaction.py`), depois regrave a variável.
- **Rollback:** `printf true | npx wrangler secret put VOICE_TTS_FREE_ONLY --name zevanory`, somente com vaga livre.
