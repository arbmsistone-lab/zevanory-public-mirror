# P18 | Segunda via independente: Supabase `pg_cron` + `pg_net` + e-mail Resend

Estado: **código pronto, NÃO ativado.** Nenhuma conta, projeto, segredo, job ou monitor foi criado por este PR.
Critérios atendidos quando ativado e ensaiado: Roteiro v4.9 seção 5/P18 e R15 ("segundo monitor administrativamente
independente, com orçamento de requisições conhecido e sem ponto único de falha compartilhado com o primeiro"),
VC-H controle 10 ("alerta em até 10 min") e P1.4 critérios 8 e 9 (alerta e queda ensaiados, tempos medidos).

## 1. Por que esta opção

| Opção | Custo | Independência do 1º monitor (GitHub) e da Cloudflare | Alerta | Decisão |
|---|---|---|---|---|
| **Supabase `pg_cron` + `pg_net`, e-mail pela API do Resend** | Zero (Supabase Free + Resend Free: 100 e-mails/dia) | Outro fornecedor (Postgres na AWS), outra conta, outro agendador, outro canal de alerta; não usa GitHub nem Cloudflare para rodar nem para avisar | Desenho ≤ ~300 s (503) / ≤ ~360 s (sem resposta); medido em teste e no ensaio | **Escolhida**: é código versionado, testável aqui (15 testes + 12 mutantes), mede os próprios tempos e guarda o histórico |
| UptimeRobot Free | Zero | Independente, mas só confere "URL respondeu"; não lê a trava, não confere o batimento do primário, não mede o próprio tempo de alerta; termos com restrições de uso | Checagem a cada 5 min | Camada extra opcional, não substituta |
| Better Stack Free | Zero | Independente; mesmas limitações de lógica; conta/equipe nova | Checagem a cada 3 min | Idem |
| Worker isolado na Cloudflare (edge #216) | Zero | **Não** é independente: Cloudflare é o alvo; o alerta passa pelo digest horário do Worker central | Até ~60 min (digest) | Restaura o gatilho do 1º monitor; não é a 2ª via |

Supabase: a pausa automática do plano Free por baixa atividade em 7 dias é o risco principal. Ver seção 6.

## 2. O que o monitor faz

A cada minuto (`p18sv.tick`, agendado por `pg_cron`):
1. recolhe as respostas das sondagens anteriores; sem resposta depois de `timeout_ms` + `response_grace_s` (padrão
   10 s + 60 s) = falha `no_response` (a fila do `pg_net` some numa queda do banco);
2. avalia cada rodada completa:
   - **disponibilidade** = `GET https://zevanory.api.br/api/health` (JSON com `ready` diferente de `false`) +
     `GET https://zevanory.api.br/api/release` (`sales_mode` = `globally-blocked` ou `enabled`) +
     `GET https://vendas.zevanory.api.br/` (página com a marca ZEVANORY). HTTP 200 sem conteúdo válido conta como queda;
   - **monitor primário** = `heartbeat.json` do ramo `evidence/b0-baseline` (esquema `zevanory.p18.heartbeat.v1`,
     `last_success_at` com menos de 20 min). Incidente e e-mail próprios: "Monitor primário (GitHub) parado";
   - **trava de vendas**: mudança de `sales_mode` gera aviso próprio ("Trava de vendas mudou: A -> B").
3. 2 rodadas seguidas com falha confirmam e pedem o e-mail na hora; lembrete a cada 6 h; 1 rodada boa recupera e manda
   um e-mail de recuperação; falha isolada abre e fecha o incidente sem e-mail;
4. dispara a próxima rodada a cada 120 s: **só GET**, sem cookie, sem credencial;
5. grava o próprio batimento (`p18sv.heartbeat`) e o resumo (`select p18sv.status();`).

**Orçamento de requisições (conhecido):** 3 GET a cada 120 s na Cloudflare = **2.160/dia** (≈ 2,2% da cota diária
do Workers Free); 720 GET/dia no `raw.githubusercontent.com`; 1 POST ao Resend por e-mail (queda, lembrete,
recuperação, aviso). Banco: ~2.900 linhas de sondagem/dia, retidas 14 dias.

**Tempo até o alerta (pior caso, queda 1 s depois de uma rodada):** 1ª rodada com falha em ≤ 120 s, recolhida no
minuto seguinte; 2ª rodada +120 s, recolhida +60 s → e-mail pedido em **≈ 300 s** (resposta 503) ou **≈ 360 s** (sem
resposta nenhuma). Medido nos testes: `P18SV_MEASURE caso=http_503 pedido_s=299 aceito_s=300`,
`caso=sem_resposta pedido_s=359 aceito_s=360`, `caso=ensaio aceito_s=211` (alvo 600). Em produção, cada incidente
registra os tempos em `p18sv.incident_report` (`deteccao_s`, `alerta_aceito_s`, `pior_caso_s`, `dentro_de_10_min`).

## 3. Pontos únicos de falha: o que é e o que não é compartilhado

| Elemento | 1º monitor | 2ª via | Compartilhado? |
|---|---|---|---|
| Agendador | GitHub Actions (+ gatilho Cloudflare, parado) | `pg_cron` no Supabase | Não |
| Execução das sondagens | Runner do GitHub (Azure) | `pg_net` no Postgres do Supabase (AWS) | Não |
| Estado e evidência | Ramo `evidence/b0-baseline` | Tabelas `p18sv.*` no Supabase | Não |
| Canal de alerta | Issue + notificação do GitHub (conta arbmsistone) | E-mail pela API do Resend (conta própria) | Não |
| Conta administrativa | GitHub arbmsistone-lab | Supabase e Resend criados com **e-mail e senha** (não "Entrar com GitHub") | Não, se o passo 1 e 2 forem seguidos |
| Caixa que recebe | arbmsistone@ (GitHub) | zevanory@gmail.com (recomendado) | Não |
| Alvo (Cloudflare, DNS de zevanory.api.br) | sim | sim | **Sim, de propósito**: é o que se monitora |

Remetente `onboarding@resend.dev` (domínio de teste do Resend, só entrega para o e-mail dono da conta Resend): o
alerta não depende do DNS de `zevanory.api.br` (Cloudflare) nem da conta Resend de produção.

## 4. Ativação pelo proprietário (sem terminal; ~20 min)

Os arquivos SQL estão em `ops/p18-segunda-via/supabase/` (no GitHub: abrir o arquivo > botão **Raw** > selecionar tudo
e copiar). Em cada "colar e rodar": Supabase > **SQL Editor** > **New query** > colar > **Run**.

1. **Resend (canal de alerta):** em resend.com > **Sign up** com **zevanory@gmail.com e senha** (não usar GitHub/Google).
   Confirmar o e-mail. **API Keys** > **Create API Key** > nome `p18-segunda-via`, permissão **Sending access** >
   **Add**. Copiar a chave (começa com `re_`); ela fica só com você.
2. **Supabase (projeto do monitor):** em supabase.com > **Start your project** com **zevanory@gmail.com e senha** (não
   "Continue with GitHub"); ativar MFA (Account > Security). **New project**: nome `zevanory-p18-segunda-via`, região
   **South America (São Paulo)**, plano **Free**, senha do banco gerada (guardar no cofre). **Não usar** o projeto ARBM
   (`arbmsistone-lab's Project`): é banco de produção com dados pessoais e misturaria as contas ZEVANORY e ARBM (P21).
   Uma conta nova tem os próprios projetos gratuitos; se mesmo assim o Supabase recusar por limite do plano Free, parar e
   decidir (não usar o projeto ARBM).
3. **Extensões:** Database > **Extensions** > procurar `pg_cron` > ligar; procurar `pg_net` > ligar
   (ou colar e rodar `000_extensoes.sql`).
4. **Esquema do monitor:** colar e rodar `001_p18_segunda_via.sql`. Esperado: "Success. No rows returned".
5. **Destinatário:** colar e rodar (trocando o e-mail se for outro; precisa ser o e-mail da conta Resend):
   `update p18sv.config set alert_to = '{zevanory@gmail.com}' where id = 1;`
6. **Chave no cofre:** Supabase > **Integrations** > **Vault** (se o menu mudar, buscar "Vault" na busca do painel) > **Add new secret** >
   Name `p18sv_resend_api_key`, Secret = a chave do passo 1 > **Save**. Não colar a chave no SQL Editor, chat ou PR.
7. **Teste do canal:** colar e rodar `select p18sv.send_test_email();`. Em até 1 min chega "[P18-2ª via] E-mail de
   teste" no Gmail (olhar Spam na 1ª vez e marcar "Não é spam"). Se não chegar:
   `select status_code, content from net._http_response order by id desc limit 1;` mostra a resposta do Resend.
8. **Ligar:** colar e rodar `002_agendar.sql` (recusa se faltar o destinatário ou a chave). Esperado: um número (id do job).
9. **Conferir (5 min depois):** `select p18sv.status();` → `enabled: true`, `tick_age_s` < 90, `ticks` ≥ 5.
   Enquanto o 1º monitor estiver parado (issues #965/#966), chega um e-mail "Monitor primário (GitHub) parado": é o
   comportamento correto (a 2ª via vendo a falha do 1º).
10. **Ensaio cronometrado (P1.4, critérios 8 e 9):** anotar a hora e rodar `select p18sv.drill_start(6);`. Em ~4 min
    chega "[ENSAIO] [P18-2ª via] Vendas/API fora do ar"; anotar a hora em que **chegou no Gmail**; ~10 min depois chega
    "[ENSAIO] ... Recuperado". Então rodar `select * from p18sv.incident_report order by id desc limit 3;` e guardar o
    resultado (print ou copiar) junto com as duas horas de chegada: é a evidência com tempos medidos.
11. **Rotina:** abrir o painel do projeto 1 vez por semana e rodar `select p18sv.status();` (também conta como atividade
    contra a pausa do plano Free). Se chegar e-mail do Supabase avisando pausa, entrar no projeto no mesmo dia.

**Desligar (reversão):** colar e rodar `003_desligar.sql` (para o job; mantém o histórico). Apagar tudo:
`drop schema p18sv cascade;` e apagar o segredo no Vault e a chave no Resend.

## 5. O que a evidência prova e o que não prova

- Prova (com o passo 10): a cadeia completa da 2ª via em produção (agendador → sondagem → decisão → e-mail aceito pelo
  Resend → chegada no Gmail → recuperação), com tempos medidos, fora do GitHub e da Cloudflare.
- Prova (testes deste PR, relógio simulado): detecção de queda real (503 e sem resposta) em ≤ 360 s, falha isolada sem
  alarme, lembrete, recuperação, batimento do primário, mudança da trava, chave nunca gravada nas tabelas.
- Não prova: uma queda real da Cloudflare (derrubar a produção não é ensaio aceitável); a verificação comercial dos
  links (PR separado, `p18-commercial-check`).

## 6. Riscos residuais

- **Pausa do Supabase Free por baixa atividade (7 dias).** O `pg_cron` roda 1.440 consultas/dia, mas a documentação não
  garante que isso conte como atividade. Mitigações: aviso por e-mail do Supabase ~1 semana antes; passo 11; e um PR
  futuro em que o vigia do GitHub lê `p18sv.status()` por uma função exposta só para leitura (cobertura cruzada).
- **Fila do `pg_net` é UNLOGGED:** uma queda do banco perde pedidos em voo; o monitor marca `no_response` (falha), nunca
  "ok".
- **A chave do Resend passa pela fila do `pg_net`** (`net.http_request_queue`) por alguns segundos até o envio. A
  permissão "Sending access" limita o estrago; girar a chave no Resend se houver suspeita.
- **Remetente `onboarding@resend.dev`** pode cair em Spam na 1ª vez (passo 7).
