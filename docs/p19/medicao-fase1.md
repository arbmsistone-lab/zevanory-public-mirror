# P19 fase 1: medição do `/api/status`, das leituras internas, do smoke pós-deploy e do P18

**Origem.** Em 18/11/2026, às 17:33Z, o deploy do P20 (`c7983f32`) foi revertido. O smoke de superfícies esgotou os 25 s numa das 6 URLs, e o traceback não dizia qual. O P18 já tinha medido 34,6 s no `/api/status` às 17:31Z, ainda na versão do C1.

Diagnóstico: `P19-DIAGNOSTICO-API-STATUS-2026-11-18.md`. Critérios: contra-auditoria P19 fase 1 do GPT-6.

**Esta fase só mede.** Nenhum timeout novo, nenhum cache e nenhuma mudança de status, payload, semântica comercial, fail-closed, limites do smoke, rollback ou autorizações da esteira.

## 1. Smoke pós-deploy (`scripts/verify-production-surfaces.py`)

O smoke registra cada leitura em até três linhas:
- **Antes da chamada:** `SURFACE_PROBE_START seq=N name=<host+caminho> at=<ISO>`.
- **Cabeçalhos recebidos:** `SURFACE_PROBE_HEADERS seq=N name=… status=… ms=… diag=<rid|->`, registrado antes de ler o corpo.
- **Corpo lido:** `SURFACE_PROBE_END seq=N name=… status=… ms=… diag=<rid|->`.
- **Em falha:** `SURFACE_PROBE_FAIL seq=N name=… ms=… phase=headers|body error_class=timeout|http_NNN|<Classe> diag=<rid|->` e `::error title=SURFACE_PROBE_TIMEOUT|SURFACE_PROBE_ERROR::<nome> falhou em N ms (<classe>, fase <fase>; …)`. A exceção **original** é relançada.
  - `phase=headers`: a resposta não chegou;
  - `phase=body`: os cabeçalhos chegaram e o corpo travou. Nesse caso, o rid já foi registrado.

**Regras mantidas:**
- o nome nunca leva query string, cabeçalhos, corpo, credenciais nem dados de clientes;
- o limite continua 25 s por leitura;
- a lista e a ordem das URLs não mudaram;
- o passo do workflow não mudou.

## 2. Worker (logs operacionais com entrada e saída)

Cada etapa grava uma linha `{"evt":"diag_stage","rid":<12 hex opaco>,"route":…,"stage":…,"phase":"start"}` **antes** de esperar. Na saída, grava `phase:"end"` com `ok`, `ms` e, em erro, `error_class`, sem a mensagem.

**Leitura que trava:** fica só a linha de entrada. O Server-Timing só existe quando há resposta.

| Rota | Etapas |
|---|---|
| `/api/status` (compat) | `operational_read` (db), `kv_sales_switch`, `kv_financial_proof`, `kv_proof_evidence` (kv) e `note` com o `request_id` interno |
| `/api/status` (runtime recuperado, `executeVerifiedRead`) | `pg_read` por rota de leitura (`read_route: canonical` ou `read-n`), com o mesmo rid, que vai pelo cabeçalho interno `x-zevanory-diag` |
| `/api/reviews/summary` | `pg_review_schema` (DDL idempotente) e `pg_review_summary` (db) |

- **Cabeçalhos públicos:**
  - `Server-Timing` só com rótulos genéricos (`db`, `kv`, `total`) e durações;
  - `x-zevanory-diag` com o rid, para o smoke correlacionar a leitura com os logs.
- **Corpo do `/api/status`:** foi comparado com o da `gh-pages` anterior à medição, pela mesma sonda. É **idêntico**, normalizado sem `request_id` nem horários.

## 3. P18 (`scripts/b0/p18-monitor.mjs`, `b0-collector.mjs`, `b0-lib.mjs`)

- **Tentativas:** cada alvo ganha `tries: [{n, started_at, ms, status|error}]`, separando a 1ª tentativa, a nova tentativa e o total (`elapsed_ms`). Os campos `latency_ms`, `attempts` e `elapsed_ms` mantêm o significado.
- **Controles de diagnóstico:** `probe.controls`, sondados **junto** com os alvos. **Não** entram em `up`, incidentes, desempenho nem abertura comercial. Dependências, conferidas no código:

| Controle | Depende de |
|---|---|
| `zevanory.api.br/api/health` | PostgreSQL (`select 1` e esquema) |
| `zevanory.api.br/api/release` | nenhuma E/S. `deployment.commit_sha` = versão servida do central |
| `edge.zevanory.api.br/api/status` | PostgreSQL e KV (mesmo handler) |
| `vendas.zevanory.api.br/health` | nenhuma E/S. `release` = versão servida do Worker de vendas |

  As páginas `vendas/` e `vendas/solucoes`, que já são alvos, também não chamam o central.
- **Falha ao ler o corpo** (cabeçalhos 200 e corpo suspenso até o tempo limite): fica em `body_error`, na tentativa e no alvo. O comportamento histórico da fase 1 não muda:
  - o status continua o HTTP recebido;
  - 200 não gera nova tentativa;
  - a página 200 continua `ok`;
  - o `/api/status` sem JSON continua não-ok, como antes.

  Um 200 com corpo vazio **lido com sucesso** não é falha. Testado com servidor HTTP real (P19.9, P19.10, P19.11).
- **Versão servida:** `probe.served = {central, sales}`, com SHA de 40 hex ou null.
- **Nova anotação:** `::notice title=P18_PROBE_DIAG::` com as tentativas e a versão servida.
- **Linha de base no C1:** o job `p19-medicao / linha de base C1` do PR faz 3 sondagens somente leitura contra a produção vigente, antes da promoção.

## 4. O que sobrevive ao rollback

| Registro | Onde fica | Sobrevive ao rollback? |
|---|---|---|
| Linhas `SURFACE_PROBE_*` e `::error` do smoke | log do job do deploy, impresso pelo próprio passo (`cat /tmp/surfaces.log`) **antes** de o passo de rollback rodar | **Sim.** O log do job é imutável. Prova: `tests/test_p19_smoke_surfaces.py` S3 roda o texto REAL do passo |
| Anotações `::error` | resumo do run | **Sim** |
| Logs `diag_stage` do Worker | logs do Worker na Cloudflare | Dependem de os logs do Worker estarem ativos e retidos. A versão revertida deixa de emitir. **Não comprovado neste PR** |
| `Server-Timing` e `x-zevanory-diag` | resposta HTTP | Só existem com resposta e enquanto a versão medida estiver ativa |
| P18 (`tries`, `controls`, `served`) | ramo `evidence/b0-baseline` | **Sim.** É independente do Worker, porque roda no GitHub |

### Alcance da correlação entre o smoke e os logs do Worker

**Correlação por identificador, inclusive sem resposta.**
- O smoke gera um rid aleatório de 12 hex (`secrets.token_hex(6)`).
- Ele o registra em `SURFACE_PROBE_START … rid=<rid>` **antes** da chamada e o envia no cabeçalho `x-zevanory-diag`.
- O Worker usa esse rid (`ridFrom`, validado: 12 hex; inválido ou ausente vira aleatório) nas linhas `diag_stage` desde a **entrada**. No runtime recuperado, isso inclui `pg_read`.

| Caso | Como chegar ao evento interno |
|---|---|
| Com resposta (cabeçalhos recebidos) | `rid` do START = `diag` devolvido = `rid` das linhas `diag_stage` |
| **Sem resposta** (`phase=headers`) | `rid` do START = `rid` das linhas `diag_stage … phase:"start"` sem `end`. Prova: P19.12, Worker real e banco travado, com o rid enviado pelo cliente |

- **Identificação:** é por **identificador**, não por horário. Duas requisições simultâneas na mesma rota têm rids diferentes.
- **`openStages()`:** continua como ferramenta auxiliar para tráfego sem rid (sondas externas). Nesse caso a correlação é só por janela e **não** vale como identificação definitiva.
- **O rid é correlação, não autenticação.** Um cliente pode enviar qualquer valor de 12 hex. O smoke gera 48 bits aleatórios por leitura.
- **Limitação que continua:** achar a linha exige os logs do Worker ativos e coletados. Depois de um rollback, o que já foi emitido fica onde a coleta operacional guardou. Este PR não comprova a retenção na conta.

### Disponibilidade na fase 1: explícito
- **Regra histórica mantida:** um **200 cujo corpo falhou** (`body_error`) continua **contado como disponível**, sem incidente nem alerta.
- **Isso não significa saudável.** O run do P18 emite `::warning title=P18_BODY_ERROR_CONTADO_COMO_DISPONIVEL::[…]` com o alvo, o status e a classe.
- **Prova:** teste "P19 fase 1: 200 com corpo interrompido…" em `tests/b0-baseline.test.mjs`. Nenhuma confirmação de queda, nenhuma issue e o aviso presente.
- **Reclassificar** esse caso como indisponível é decisão da fase 2.

## 5. O que esta fase prova e o que segue aberto

- **Provado em ensaio:**
  - o timeout identifica a sonda e a duração, e a falha original é preservada;
  - a entrada da leitura do PostgreSQL fica registrada quando o banco não responde;
  - o corpo e o status do `/api/status` não mudam.
- **Em aberto:**
  - a **causa** do travamento em produção. O PostgreSQL é a hipótese principal; ainda não estão descartados:
    - o binding entre Workers (vendas → CORE);
    - a execução no edge;
    - o ambiente da sonda (imagem do executor confundida com a data);
  - a medição do lado do Worker de vendas, antes de chamar o CORE. Ficou fora para não acionar outro deploy.
