# P20 — Cifragem da cópia de backup Neon → Cloudflare KV

Roteiro Mestre v4.7, seção 9.1. Fecha a lacuna `copia_cifrada` que o ensaio mensal registrava em `not_covered`
(`scope_complete_9_1: false`). O contrato da cópia, do manifesto e do ensaio está em
[`inventario-estado-critico.md`](inventario-estado-critico.md).

## O que muda

| Antes | Depois (com a chave cadastrada) |
|---|---|
| `zpc:backup:v1:neon:<dia>:part:<n>` guarda o JSON `{tabela: json}` em texto claro | a mesma chave guarda um **envelope AES-256-GCM** desse mesmo JSON |
| manifesto = SHA-256 de cada tabela (texto claro) | **igual**: o manifesto continua sobre o texto claro e é conferido depois de decifrar |
| ensaio diário do Worker relê a cópia e confere | relê, **decifra** (mesma AAD) e confere; exige o envelope |
| ensaio mensal lê e restaura | lê os **dois formatos**, decifra com `P20_BACKUP_KEYS` e registra `copia_cifrada` por parte |

Código: `worker/backup-crypto.mjs` (Worker, WebCrypto), `worker/data-backup.mjs` (uso),
`scripts/p20/backup-envelope.mjs` (ensaio, `node:crypto`, implementação independente), `scripts/p20/restore-drill-lib.mjs`.

## Formato do envelope (versão 1)

Valor JSON gravado no KV:

```json
{ "$enc": "zevanory-backup-enc/v1", "v": 1, "alg": "A256GCM", "kid": "<16 hex>",
  "nonce": "<base64 de 12 bytes>", "aad": { "day": "AAAA-MM-DD", "part": 0, "key": "zpc:backup:v1:neon:AAAA-MM-DD:part:0" },
  "ct": "<base64 de ciphertext || tag de 16 bytes>" }
```

- **Algoritmo:** AES-256-GCM, tag de 128 bits.
- **Nonce:** 96 bits aleatórios (`crypto.getRandomValues`) gerados a cada cifragem. O Worker cifra uma vez por parte por
  dia. Com a mesma chave, o risco de colisão de nonce aleatório só fica relevante perto de 2³² cifragens, ou seja,
  milhões de anos neste ritmo. Rotacione a chave por higiene, não por esse limite.
- **AAD:** `zevanory-backup-enc|v=1|alg=A256GCM|day=<dia>|part=<n>|key=<chave do bundle>`. Ela é sempre **recalculada**
  a partir do dia e da parte esperados, nunca lida do envelope. Mover o envelope de dia ou de parte, ou trocar versão ou
  algoritmo, invalida a tag. O campo `aad` do envelope só serve para dar um erro claro (`aad_mismatch`).
- **kid:** os 16 primeiros caracteres hex de `SHA-256("zevanory-p20-backup-kid/v1|" || chave)`. Ele identifica a chave
  sem revelá-la e aparece nos relatórios. A chave em si nunca aparece.
- **Legado:** um bundle sem a marca `$enc` é texto claro. `$enc` não é nome de tabela válido, então os dois formatos
  não se confundem.

Códigos de falha (só códigos, nunca material de chave): `bundle_kid_unknown`, `bundle_decrypt_failed` (chave errada,
ciphertext, tag, nonce ou AAD adulterados), `bundle_aad_mismatch`, `bundle_envelope_malformed`,
`bundle_envelope_version_unsupported`, `bundle_encryption_downgrade` (a parte declara "cifrado" e o bundle chegou em
claro), `backup_keyring_malformed` e `backup_keyring_kid_mismatch`. No Worker: `backup_key_invalid`,
`backup_key_absent_encryption_required`, `neon_copy_unreadable:<código>` e `neon_copy_not_encrypted`.

## Chave

| Onde | Nome | Conteúdo |
|---|---|---|
| Worker central `zevanory` (secret) | `P20_BACKUP_KEY` | base64 de 32 bytes aleatórios (a chave **ativa**) |
| GitHub, Environment `producao-critica` (secret) | `P20_BACKUP_KEYS` | a(s) chave(s) aceitas na restauração |

- **Um único segredo novo no Worker.** O Worker central está no limite de 60 bindings
  (`scripts/deploy/check-binding-budget.py`). O kid é derivado da própria chave, e a flag de fase fica no código
  (`ENCRYPTION_REQUIRED` em `worker/backup-crypto.mjs`). Nenhuma das duas ocupa binding.
- `P20_BACKUP_KEYS` aceita uma chave base64, várias separadas por vírgula (`nova,antiga`) ou JSON `{"<kid>": "<base64>"}`.
  No formato JSON, o kid declarado precisa ser igual ao derivado; se não for, o ensaio para com
  `backup_keyring_kid_mismatch`.
- A chave nunca vai para o repositório, para log, para relatório, para o próprio backup ou para mensagem de erro. Os
  testes E9 e test_6/test_7 conferem isso.
- **Perder a chave é perder os backups cifrados com ela.** Não há recuperação. Guarde uma cópia fora do Cloudflare e do
  GitHub, por exemplo num gerenciador de senhas, sob a guarda do proprietário.

### Rotação

1. Gere a chave nova.
2. No Environment, troque `P20_BACKUP_KEYS` para `nova,antiga`.
3. No Worker, troque `P20_BACKUP_KEY` pela nova.
4. Depois de 8 dias, quando a retenção do KV tiver expirado todos os bundles da chave antiga, deixe só a nova em
   `P20_BACKUP_KEYS`.

No primeiro backup com a chave nova, o incremental não abre o bundle anterior e faz uma exportação completa, sem falha.
Isso custa uma vez a transferência do Neon (teste E8).

## Fases (transição fail-closed controlada)

**Fase 1 — este PR (`ENCRYPTION_REQUIRED = false`)**

- Com `P20_BACKUP_KEY` válida no Worker, cada parte é gravada cifrada e o relatório da parte traz
  `encryption.state = "cifrado"` e o kid.
- Sem a chave, o comportamento atual continua: a parte vai em texto claro, com `encryption.state = "nao_cifrado"` e o
  alerta `warnings: ["backup_nao_cifrado"]`. O consolidado traz `encryption.state` (`cifrado`, `parcial` ou
  `nao_cifrado`) e o workflow `data-backup.yml` emite `::warning title=DATA_BACKUP_NAO_CIFRADO::`.
- Com a chave cadastrada mas inválida (base64 ruim ou tamanho diferente de 32 bytes), a parte falha **antes de
  qualquer escrita** (`backup_key_invalid`). O Worker nunca cai para texto claro em silêncio.
- O ensaio mensal lê os dois formatos e registra `backup.parts[i].copia_cifrada` e `backup.copia_cifrada`. A lacuna
  `copia_cifrada` só sai de `not_covered` quando as 3 partes do dia foram lidas, decifradas e estão cifradas. A
  releitura estrita (`validateRecord`) recusa um registro que retire a lacuna sem essa prova. Registros antigos, sem o
  campo, continuam válidos.

**Fase 2 — PR próprio, depois de um ensaio mensal `ENSAIO_EM_PRODUCAO` aprovado com `backup.copia_cifrada: true`**

- Trocar `ENCRYPTION_REQUIRED` para `true`. A partir daí, sem chave nada é gravado em texto claro
  (`backup_key_absent_encryption_required`), e o consolidado com qualquer parte não cifrada falha
  (`backup_nao_cifrado:<estado>`). Os testes E7 já cobrem os dois casos.

## Backups antigos em claro (migração e retenção)

- **Nada é apagado neste PR.**
- `zpc:backup:v1:neon:*` expira por TTL do KV em **8 dias**. Assim, em até 8 dias depois do cadastro da chave não resta
  bundle diário em claro, sem nenhuma ação.
- As cópias estendidas `zpc:backup:v1:preserved:*` (`backup-preserve-archive.yml`, modo `kv-extend`, 75 dias) e o
  arquivo cifrado por senha dessa ferramenta não mudam. As cópias estendidas já gravadas continuam em claro até o TTL
  delas. Apagar antes do prazo é decisão do proprietário, fora deste PR.
- `scripts/ops/backup_preserve_archive.py` só lê bundles legados. Diante de um envelope, para com
  `bundle_encrypted_not_supported` em vez de um erro genérico. O `kv-extend` copia o valor como está, e a AAD continua
  presa à chave original.
- A cópia inversa KV → Neon (`zevanory_kv_backup`) não muda: ela vive no Neon e não é o objeto da lacuna.

## Passo a passo do proprietário (depois do merge)

> Antes do passo 2: o deploy central só passa se `segredos + vars ≤ 60`. Abra o último `central-production-deploy` e
> procure `BINDING_BUDGET_PASS planned=N spare=S`. Se `planned` já for 60, compacte uma var antes (procedimento de
> `scripts/deploy/prepare-central-candidate.py` e `tests/test_binding_budget_compaction.py`). Sem isso, o próximo deploy
> é bloqueado (fail-closed).

1. **Gerar a chave no seu computador.** Ela vai para um arquivo e não aparece na tela:
   `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > p20-backup.key`
   Se preferir ver a chave para copiá-la a um gerenciador de senhas, use a forma
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Só você a vê.
2. **Worker:** `npx wrangler secret put P20_BACKUP_KEY --name zevanory < p20-backup.key`
   (conta `1b264158…`), ou cole o valor no painel do Cloudflare (Worker `zevanory` → Configurações → Variáveis e
   segredos → Secret).
3. **GitHub:** `gh secret set P20_BACKUP_KEYS --env producao-critica --repo arbmsistone-lab/zevanory-public-mirror < p20-backup.key`,
   ou cole o valor em Settings → Environments → `producao-critica` → Add secret.
4. **Guardar** uma cópia no seu gerenciador de senhas e **apagar** o arquivo (`rm p20-backup.key`).
5. **Conferir no dia seguinte:** o `data-backup.yml` deve mostrar `encryption:"cifrado"` nas 3 partes e nenhum
   `DATA_BACKUP_NAO_CIFRADO`.
6. **Conferir a restauração:** dispare o `p20-monthly-restore-drill.yml` e aprove o Environment. O registro deve ter
   `verdict: APROVADO`, `backup.copia_cifrada: true` e `not_covered` sem `copia_cifrada`. Depois disso, a fase 2 pode
   ser aberta.

Se o passo 3 ficar faltando, o ensaio mensal reprova com `bundle_kid_unknown:<n>`: a cópia existe, mas o CI não consegue
restaurá-la. É o sinal correto.

## Como testar (local, sem rede e sem segredo real)

- `node --test tests/p20-backup-encryption.test.mjs` (E1–E10):
  - round-trip Worker↔node;
  - chave errada;
  - ciphertext, tag, nonce, AAD, posição e versão adulterados;
  - kid desconhecido e conjunto de chaves inválido;
  - legado e partes mistas;
  - rebaixamento para texto claro;
  - nonces de 4096 cifragens distintos e com bits equilibrados;
  - fases do Worker (com chave, sem chave, obrigatória, chave inválida, releitura adulterada ou rebaixada);
  - incremental e rotação;
  - nenhum material de chave em log, relatório, KV ou registro;
  - workflows.
- `PGHOST=localhost … python3 -m unittest tests.test_p20_restore_drill`: o código real do Worker grava o backup cifrado
  com chave sintética, e o ensaio decifra e restaura tudo num Postgres descartável (test_6). Sem a chave, reprova sem
  restaurar (test_7).
- `python3 scripts/ci/mutants_p20_restore_drill.py`: entre os mutantes, nonce fixo, AAD omitida, AAD não conferida, tag
  não verificada, queda silenciosa para texto claro (obrigatória ou chave inválida), rebaixamento aceito, lacuna
  retirada com cópia parcial, kid não conferido, kid desconhecido aceito e chave em mensagem de erro. Todos precisam
  ser mortos.
