# Preservação do backup íntegro de 14/10/2026: procedimento executável

**Origem:** ordem P0 de 15/10/2026 (incidente Neon HTTP 402). **Processo:** P20, ligado a P19, P21 e P22. **Executor:** Claude.

## Por que é urgente
- **O backup:** 14/10/2026 10:09 UTC (run 38547624427), com 51 tabelas, 18.142 linhas e restauração ensaiada com 51/51 OK.
- **Onde está:** chaves `zpc:backup:v1:neon:2026-10-14:part:{0,1,2}` no KV de produção, com TTL de 8 dias. **Expiram por volta de 22/10/2026 10:10 UTC.**
- **O conflito de datas:** o Neon só volta em 01/11/2026 00:00 UTC (reset do ciclo). A cópia expira 10 dias antes da recuperação.
- **Os relatórios por parte** (`zpc:backup:v1:report:part:N`, TTL de 3 dias) foram sobrescritos pelas execuções com falha de 15/10. A âncora de integridade passa a ser **o próprio conteúdo**: o SHA-256 por tabela é recalculado e registrado no manifesto.

## O que este PR entrega (não executado)
- `scripts/ops/backup_preserve_archive.py`, com os modos:
  - `inspect` (metadados);
  - `archive` (cifra e manifesto);
  - `verify` (hashes e restauração em Postgres efêmero);
  - `kv-extend` (cópia com retenção estendida, que é escrita).
- `.github/workflows/backup-preserve-archive.yml`: só disparo manual na gh-pages; artefato cifrado com 90 dias de retenção, até ~13/01/2027, depois de 01/11.
- `tests/test_backup_preserve_archive.py`: 9 testes com dados fictícios, cobrindo:
  - cifragem de ida e volta;
  - SHA igual ao do Worker;
  - contagens exigidas;
  - adulteração e senha errada recusadas;
  - nenhum dado em log;
  - a cópia original nunca é alterada.
- **Restauração real verificada localmente** num Postgres 16 com dados fictícios: `hashes: ok`, restauração com 3/3 tabelas.

## Sequência e autorizações necessárias
| # | Passo | Tipo | Quem autoriza ou faz | Prazo |
|---|---|---|---|---|
| 1 | Push do branch e abertura do PR | Escrita no repositório | Proprietário: "AUTORIZO PR DA PRESERVAÇÃO DO BACKUP" | Hoje |
| 2 | Merge na gh-pages (workflow_dispatch exige o arquivo no branch padrão) | Merge | Proprietário, com autorização por SHA, depois dos checks | Até 20/10 |
| 3 | Criar o secret `BACKUP_ARCHIVE_PASSPHRASE` (≥ 32 caracteres, gerada e guardada **só** pelo proprietário, num cofre de senhas) | Credencial, classe D | **Proprietário** (Settings → Secrets → Actions) | Antes do passo 5 |
| 4 | Rodar o workflow em modo `inspect` (lê só metadados: nomes e expiração) | Leitura | Autorização do proprietário para o disparo | Depois do passo 2 |
| 5 | Rodar em modo `archive` (lê os valores, cifra, envia o artefato e verifica a restauração) | Leitura de dados pessoais, processada cifrada | Proprietário: "AUTORIZO ARQUIVAR O BACKUP 2026-10-14" | **Antes de 22/10 10:10 UTC** |
| 6 | Opcional: `kv-extend` (3 escritas no KV; cópia com 75 dias, original intocada) | Escrita em produção | Proprietário, mais a frase `PRESERVAR 2026-10-14` | Antes de 22/10 |

**Critério de PASS do P20 (preservação):** passo 5 verde, com o manifesto mostrando 51 tabelas e 18.142 linhas, e o job `verify-restore` verde (hashes ok, contagens restauradas iguais). As anotações do run são a evidência.

## Restauração depois do reset (01/11)
1. Baixar o artefato, decifrar com a senha (o modo `verify` faz isso em CI) e conferir o manifesto.
2. Comparar com o estado do Neon reativado (diferença tabela a tabela): o que está no Neon e não está na cópia é posterior a 14/10 10:09 UTC.
3. Restaurar no Neon **somente** o que estiver faltando ou corrompido, com autorização. Nunca sobrescrever dados mais novos com a cópia antiga.

## Riscos
- **Dados pessoais** saem do Cloudflare para o armazenamento de artefatos do GitHub, **sempre cifrados**. Sem a senha, o artefato não é legível. A senha nunca vai para log nem para arquivo.
- **Repositório público:** qualquer usuário logado pode baixar o artefato cifrado. A proteção é a cifra (AES-256-GCM com scrypt, N=2^15) e uma senha forte.
- **Senha perdida = backup perdido.** O proprietário deve guardá-la em dois lugares seguros.
