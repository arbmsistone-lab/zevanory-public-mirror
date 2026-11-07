# P20 — Vaga de binding para `P20_BACKUP_KEY`

**Status:** PROPOSTA. Nada foi feito em produção.

## Por que

O deploy central só passa se o total de nomes de segredos e vars do Worker `zevanory` for no máximo 60
(`scripts/deploy/check-binding-budget.py`). Esse total inclui `CHANNEL_CREDENTIALS_JSON`. A cifragem do backup
(`docs/p20/cifragem-backup.md`) precisa de **um** segredo novo, `P20_BACKUP_KEY`. O valor 60 de partida é a premissa da
coordenação. Ele precisa ser confirmado no último log `BINDING_BUDGET_PASS planned=N` do `central-production-deploy`,
porque este repositório não lê o estado vivo.

## Decisão: compactar duas flags não sensíveis

A primeira proposta foi apagar o segredo `VOICE_TTS_FREE_ONLY` (análise no anexo). A contra-auditoria GPT-6 **vetou**
essa proposta. A aprovada consolida duas plain vars não sensíveis em `ZEVANORY_RUNTIME_CONFIG`, que já é um binding
existente, no mesmo padrão já usado para `ARBM_SIST_*`, `CLOUDFLARE_AI_*`, `AGENT_AUTONOMY_MODE` e outras:

| Var | Valor (base 83620c6) | Natureza |
|---|---|---|
| `OFFER_SELECTION_APPROVED` | `"true"` | decisão de prontidão comercial (não é a chave de venda) |
| `SERVICE_DELIVERY_MODE` | `"digital"` | modo de entrega da oferta |

O código está em `scripts/deploy/prepare-central-candidate.py` (bloco `P20_COMPACTED_FLAGS`): retira a var do topo e
grava o **mesmo** valor no runtime config. Se o runtime config já tiver um valor **diferente**, o gerador falha
(`RUNTIME_CONFIG_COMPACTION_CONFLICT`) em vez de sobrescrever ou ser sobrescrito, porque nos dois resolvedores a var de
topo tem precedência sobre o runtime config. Nenhum segredo, token ou chave vai para a config.

### Por que estas duas (e não as outras)

As 28 plain vars planejadas pelo gerador (base 83620c6, candidato gerado no teste) são:

- **Venda, checkout e financeiro (fora):** `ABSOLUTE_RELEASE_APPROVED`, `CHECKOUT_ENABLED`, `FINANCIAL_EVENTS_ENABLED`,
  `MERCADOPAGO_ENV`, `PAYMENT_MERCHANT_IDENTITY_VERIFIED`, `PAYMENT_PROVIDER`, `PAYMENT_PUBLIC_BASE_URL`,
  `PAYMENT_RUNTIME_MODE`, `PRE_SALE_GATES_APPROVED`, `SALE_GLOBALLY_ENABLED`, `WHATSAPP_SALES_ENABLED`, `ASAAS_ENV`.
- **Compliance (fora):** `COMPLIANCE_RUNTIME_ALLOWED_ORIGINS`, `COMPLIANCE_RUNTIME_MODE`, `COMPLIANCE_RUNTIME_ORIGIN`,
  `COMPLIANCE_RUNTIME_ORIGIN_RELEASE_ID`, `COMPLIANCE_RUNTIME_ORIGIN_VERIFIED`.
- **Release e implantação (fora; `NEVER_COMPACT` de `tests/test_binding_budget_compaction.py`):** `ZEVANORY_RELEASE_SHA`,
  `ZEVANORY_DEPLOYMENT_ENV`, `AGENT_AI_ENABLED`, `AGENT_HUMAN_APPROVAL_REQUIRED`.
- **O próprio binding:** `ZEVANORY_RUNTIME_CONFIG`.
- **Candidatas não sensíveis:** `ACTIVE_OFFER_TYPE`, `OFFER_SELECTION_APPROVED`, `SERVICE_DELIVERY_MODE`,
  `ORGANIC_PUBLISHING_ENABLED`, `ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED`, `ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY`.

Situação das sugestões da coordenação:

- **Já resolvidas antes deste PR:** `SUPPORT_CHANNEL` já é **removida** pelo gerador (WhatsApp aposentado), e
  `ARBM_SIST_*` e `CLOUDFLARE_AI_*` já estão no runtime config. Nenhuma delas ocupa slot hoje.
- **Não escolhidas:**
  - `ACTIVE_OFFER_TYPE` decide o ramo de toda a avaliação de prontidão.
  - `ORGANIC_PUBLISHING_ENABLED` tem 3 leitores.
  - `ZEVANORY_PRODUCT_HANDOFF_V21_VERIFIED` e `ZEVANORY_SECURE_ARTIFACT_DELIVERY_READY` também são lidas por
    `publicOffer`.
- **Escolhidas:** `OFFER_SELECTION_APPROVED` e `SERVICE_DELIVERY_MODE` têm **um único leitor cada**.

### Prova de leitores (grep em `worker/**`, `sales-worker.mjs`, `scripts/**` e `.github/workflows/**`)

```
worker/cloudflare-worker.recovered.mjs:1131:  if (!yes2(env.OFFER_SELECTION_APPROVED)) blockers.push("offer_selection_not_approved");
worker/cloudflare-worker.recovered.mjs:1298:  offer_selection_not_approved: requirement("commercial", ["OFFER_SELECTION_APPROVED"], "decision"),   (metadado, não lê env)
worker/cloudflare-worker.recovered.mjs:1149:    if (!["digital", "remote"].includes(String(env.SERVICE_DELIVERY_MODE || "")...)) blockers.push("service_delivery_mode_missing");
worker/cloudflare-worker.recovered.mjs:1300:  service_delivery_mode_missing: requirement("commercial", ["SERVICE_DELIVERY_MODE"], "decision"),   (metadado)
```

- **Leitor único:** nenhum outro módulo de `worker/` lê as duas vars, inclusive os que recebem `env` cru:
  - `site-chat.mjs`;
  - `atendimento.mjs`;
  - `data-backup.mjs`;
  - `sales-public-worker.mjs`, que é outro Worker.
- **Gates de CI:** nenhum script nem workflow as lê como var de topo. Isso vale para `voice_support_gate.py`,
  `zero_cost_guard.py`, `launch_config_contract.py`, `premerge_product_audit.py` e `credential_separation_gate.py`.
- **A mesma função já serve flags compactadas:** as duas leituras ficam em `evaluateActivationReadiness(env)`, que já lê
  `env.ARBM_SIST_PRIVATE_PILOT_DELIVERY_APPROVED`, já compactada, pelo **mesmo** `env`.
- **Cadeia de chamadas e origem do `env`:**
  - quem chama `evaluateActivationReadiness`: `preSaleApproval` ← `salesGate`, `buildActivationPlan`,
    `certificationPilotPolicy` e o `handler6`;
  - o `env` que chega ali é sempre um destes três:
    - o `normalized` do compat (`normalizeEnv(productionEnvView(env))`, com o fallback para o runtime config que o
      gerador injeta em `worker/binding-aliases.mjs`);
    - o `process.env` depois de `hydrateRuntimeConfig`, que copia as chaves do runtime config. Ela roda no início de
      `fetch`, `scheduled`, `runSalesPreflight` e `runPaidDeliveryWatchdog`, e o compat só chama esses pontos com
      `normalized`;
    - um spread de `process.env` (`{...process.env, ...}`), que herda essas chaves;
  - além disso, `preSaleApproval(Object.freeze({}))` é chamado no carregamento do módulo, sem as chaves antes e
    depois.
- **Nenhum spread do proxy chega ao leitor:** os únicos `...env` do bundle ficam em:
  - `channelReadiness` (WhatsApp);
  - `ttsBytesFromRuntime` e o status de voz (`statusEnv`, só para `voiceProviderStatus`);
  - `runPaidDeliveryWatchdog` (drenagem do Mercado Pago, outro módulo).
- **Fora das flags fail-closed:** nenhuma das duas está em `FAIL_CLOSED_RUNTIME_FLAGS`, que obrigaria `"false"` e
  ignoraria o runtime config.

### Escritores, recuperação e rollback

- **Único escritor da config viva:** `central-production-deploy.yml`, via o gerador. O `central-candidate-dryrun.yml`
  usa o mesmo gerador, só em dry-run.
- **O deploy real não usa `--keep-vars`:** as duas vars somem do topo do Worker no deploy seguinte, em vez de ficarem
  duplicadas.
- `central-fix-candidate.yml` monta a config a partir da base, mas **só faz dry-run**.
- `mercadopago-exact-sha-recovery.yml` (recuperação manual) monta a config a partir da base sem o gerador, mas está
  **aposentado de vez** (`if: ${{ false }}`).
- **Rollback automático** (`wrangler rollback --name zevanory`): restaura uma versão anterior inteira, com as vars de
  topo antigas e os **mesmos valores**. O efeito é idêntico. Se o rollback voltar a uma versão anterior ao cadastro de
  `P20_BACKUP_KEY`, o backup cai para a fase 1 (`nao_cifrado`, com alerta). Não há perda de dado; a chave fica com o
  proprietário.
- Os testes estáticos (abaixo) quebram se surgir outro escritor ou leitor.

### Testes (`tests/test_binding_budget_compaction.py`, classes `P20BindingVacancy*`; rodam no `t1-publisher-guard.yml`)

Os testes geram o candidato **real** a partir de `83620c6:wrangler.jsonc` e `public/`, com o gerador atual e com o
gerador sem o bloco P20. Depois conferem:

- **Movimento:** as duas vars saem do topo com valor idêntico no runtime config, e todo o resto da config fica igual.
- **Orçamento** (`check-binding-budget.py` real, com segredos sintéticos que levam a base a 60):

  | Situação | `planned` |
  |---|---|
  | antes | 60 PASS |
  | antes + `P20_BACKUP_KEY` | 61 FAIL |
  | depois | 58 PASS |
  | depois + `P20_BACKUP_KEY` | **59** PASS |

- **Equivalência:** com o `normalizeEnv` real (já modificado pelo gerador), o `productionEnvView` real e o código real
  de `hydrateRuntimeConfig` (extraído do bundle), todos os mais de 70 nomes resolvem para o mesmo valor antes e depois.
  As duas flags dão `true` e `digital` nos dois casos.
- **Conflito:** um valor diferente no runtime config derruba o gerador; o mesmo valor passa.
- **Estático:**
  - leitor único dentro de `evaluateActivationReadiness`;
  - ausência das duas em `FAIL_CLOSED_RUNTIME_FLAGS` e em `NEVER_COMPACT`;
  - nenhum spread do proxy chega ao leitor;
  - os pontos de entrada hidratam e recebem `normalized`;
  - os outros escritores continuam em dry-run ou aposentados.

Validação dos próprios testes, com mutações temporárias no gerador, todas detectadas:

- compactar também `CHECKOUT_ENABLED`;
- gravar um valor diferente;
- tirar a guarda de conflito.

## Ordem operacional (proprietário; nada disto foi feito)

1. **Merge** deste PR.
2. **Deploy central** (`central-production-deploy`, automático no push). Ele deve imprimir
   `BINDING_BUDGET_PASS planned=58` (60 − 2) e as duas vars somem do topo do Worker.
3. **Cadastrar `P20_BACKUP_KEY`** (passos 2 a 4 de `docs/p20/cifragem-backup.md`). O orçamento vivo vai a 59.
4. **Próximo deploy** imprime `planned=59`, com uma vaga de folga.

A ordem importa: cadastrar o segredo antes do deploy da compactação levaria a 61 e bloquearia o deploy
(`BINDING_BUDGET_EXCEEDED`).

## Anexo — proposta vetada: apagar `VOICE_TTS_FREE_ONLY` (registro histórico)

A GPT-6 vetou a proposta. **Não execute.** A análise abaixo fica registrada porque achou fatos úteis: `/api/voice-study/*` é
pública e o `voice-eval` semanal depende do fallback.

### O que a variável faz

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

### Todos os consumidores (`git grep -n VOICE_TTS_FREE_ONLY`)

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

### Onde a premissa da coordenação não se confirmou (registro honesto)

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

### Gates de CI sem a variável

Os dois gates são estáticos (leem o código e o gerador do deploy, nunca o segredo vivo). Por isso não mudam com a remoção:

```
$ python3 scripts/zero_cost_guard.py
ZERO_COST_GUARD=PASS
$ python3 scripts/voice_support_gate.py
VOICE_ENGINE_STATIC_GATE=PASS … VOICE_PRODUCTION_FAIL_CLOSED_ZERO_SPEND_CONFIG_GATE=PASS … WHATSAPP_RETIRED_ONBOARDING_GATE=PASS … VOICE_CANONICAL_FINAL_CLOSURE_GATE=PASS   (rc 0)
```

`voice_support_gate.py:85` exige que o gerador do deploy **não** grave `VOICE_TTS_FREE_ONLY` como var. Isso continua
verdadeiro: a remoção é do segredo, fora do deploy.

### Cuidados

- **Não rode** `voice-zero-spend-enable.yml`, `voice-gemini-production-provision.yml` nem `voice-gemini-auth-key-probe.yml`
  depois da remoção. Eles regravam `VOICE_TTS_FREE_ONLY` e o orçamento voltaria a 61, o que bloqueia o deploy.
- **Para religar a voz no futuro:** primeiro libere outra vaga (compactação no `ZEVANORY_RUNTIME_CONFIG`,
  `tests/test_binding_budget_compaction.py`), depois regrave a variável.
- **Rollback:** `printf true | npx wrangler secret put VOICE_TTS_FREE_ONLY --name zevanory`, somente com vaga livre.
