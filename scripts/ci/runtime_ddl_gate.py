#!/usr/bin/env python3
"""ZEVANORY | Gate estático do DDL de tempo de execução do Worker (contra-auditoria do #1008).

Lacuna: o #1008 pôs DDL interpolado em worker/affiliate-program.mjs. scripts/ops/restore_new_database.py (runtime_ddl, que
varre TODOS os worker/*.mjs) recusa isso, mas o check p20-restore-drill não rodou (filtro `paths` só lista alguns workers)
e não é obrigatório. Este gate roda dentro do check obrigatório "product-pages / static-audit" (os DOIS emissores:
product-pages-premerge.yml e required-status-compat.yml), sem filtro de caminho, sem Postgres e sem rede.

O que confere (fail-closed, código 1 em qualquer divergência):
  1. ESCANEAMENTO INDEPENDENTE (este arquivo, reservado): em cada worker/*.mjs, todo `create table if not exists <nome> (`
     - abre logo depois do delimitador JS da string (" ' `; só espaço e comentário SQL /*...*/ no meio) e o corpo inteiro,
       até o parêntese que fecha, NÃO contém esse delimitador (NC-1013-01: `"... default "+RATE4+",..."` é valor
       concatenado e o restore extrairia SQL quebrado) nem `${` (valor interpolado);
     - tem nome literal. Exceções pinadas, cada uma com EXATAMENTE um comando: `${BACKUP_TABLE}` em worker/data-backup.mjs
       (com `const BACKUP_TABLE = "zevanory_kv_backup";` como única atribuição) e a concatenação
       `"create table if not exists "+table` em worker/whatsapp-neon-store.mjs (DDL capturado no item 3). Qualquer outro
       nome interpolado/concatenado seria PULADO em silêncio pelo restore e reprova.
  2. FONTE ÚNICA (NC-1013-02): executa runtime_ddl() de scripts/ops/restore_new_database.py num processo separado e exige
     as mesmas tabelas E a mesma lista de comandos (texto exato, na mesma ordem) que o escaneamento independente monta
     com a mesma regra de extração. Restore que devolve só nomes, menos comandos ou comandos diferentes reprova.
  3. executa dynamic_ddl() do mesmo script (node, banco falso que só registra comandos) e exige exatamente os 12 comandos
     esperados (4 tabelas whatsapp_* e 2 índices de cada, nesta ordem), sem interpolação, E (OBS-1013-03) igualdade
     INTEGRAL, depois de normalizar espaços, com a FONTE PRÓPRIA: o array `ddl` de worker/whatsapp-neon-store.mjs lido
     estaticamente (literais de string JS, `+` e o identificador `table`, expandido sobre `TABLES` na ordem do código).
     Coluna ou restrição trocada que preserve os nomes reprova (DYNAMIC_DDL_DIVERGE_DA_FONTE). Se o worker mudar de
     forma que o extrator não entenda, reprova FONTE_DINAMICA_NAO_EXTRAIVEL (fail-closed): adapte o extrator ou, se não
     houver como extrair, troque por um sha256 fixado do SQL normalizado, sob rótulo de dono (arquivo reservado).
  4. FORMATO (follow-up do #1013): toda ocorrência de `create table`, `create [unique] index` e `alter table`
     - em worker/**/*.{mjs,js,cjs,ts,mts,cts} fora de worker/*.mjs reprova (DDL_FORA_DO_ALCANCE_DO_RESTORE: o restore só
       lê worker/*.mjs);
     - `create table` que a regex do restore não reconhece (espaço duplo, sem IF NOT EXISTS, temp/unlogged...) reprova
       (DDL_FORMATO_FORA_DO_RESTORE);
     - `create index` precisa ser literal: dentro de string JS, sem `${` e sem `+` depois do fechamento (INDEX_NAO_LITERAL);
     - `alter table` precisa ser capturado INTEIRO pela regex do restore, até o fechamento da string, sem `${` e sem `+`
       depois do fechamento (ALTER_FORA_DO_RESTORE: interpolado, concatenado, `default 'x'` truncado, várias colunas).
     Exceções estreitas, cada uma com cota exata: `create table ${DRILL}.%I (like public.%I)` em data-backup.mjs (esquema
     de ensaio `zevanory_restore_drill`, atribuição única), os 2 `create index` concatenados de whatsapp-neon-store.mjs
     (capturados no item 3) e os ALTERs multi-coluna de zevanory_kv_backup (data-backup.mjs) e zevanory_support_inbound
     (support-email-forward.mjs), aceitos só se cada coluna adicionada já estiver, com o mesmo tipo, no CREATE TABLE
     literal da mesma tabela no mesmo arquivo (ALTER_EXCECAO_NAO_REDUNDANTE caso contrário).
  --self-test: fixtures de worker (limpo passa; DDL interpolado, valor concatenado no corpo, nome interpolado, nome
  concatenado, exceção repetida, BACKUP_TABLE trocado, ALTER/INDEX interpolados ou concatenados, create com espaço duplo
  ou sem IF NOT EXISTS, .mjs em subdiretório, .js, ALTER multi-coluna não redundante reprovam), restores enfraquecidos em
  cópia temporária (só nomes, dinâmico fixo de 1 comando, um comando a menos, coluna/restrição trocada no dinâmico) e
  fontes dinâmicas alteradas (coluna trocada diverge; forma não extraível reprova).
  --worker-dir: varre outro diretório (teste negativo do guarda).

Saída: linhas `RUNTIME_DDL_GATE ...`; código 0 = PASS, 1 = FAIL, 2 = entrada inválida."""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESTORE = ROOT / 'scripts' / 'ops' / 'restore_new_database.py'
# mesmas regexes de restore_new_database.RUNTIME_DDL / RUNTIME_ALTER (a igualdade dos comandos é conferida no item 2)
DDL = re.compile(r"create table if not exists\s+(?:public\.)?(\$\{BACKUP_TABLE\}|[a-z_][a-z0-9_]*)\s*\(", re.I)
ALTER = re.compile(r"alter table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add column if not exists\s+[a-z_][a-z0-9_]*\s+[a-z ]+?(?=[`'\";])", re.I)
# qualquer `create table if not exists` seguido de nome que NÃO é identificador literal
NOME_NAO_LITERAL = re.compile(r"create table if not exists\s+(?:public\.)?(?![a-z_][a-z0-9_]*\s*\()(\$\{[^}]*\}|[\"'`]\s*\+|\S+)", re.I)
# (arquivo, nome não literal) -> quantidade EXATA de comandos aceitos
EXCECOES_NOME = {('data-backup.mjs', '${BACKUP_TABLE}'): 1, ('whatsapp-neon-store.mjs', '+'): 1}
BACKUP_CONST = 'const BACKUP_TABLE = "zevanory_kv_backup";'
BACKUP_ATRIB = re.compile(r'\bBACKUP_TABLE\s*=(?!=)')
DINAMICO_ESPERADO = [(k, t + s) for t in ('whatsapp_stage_events', 'whatsapp_observations', 'whatsapp_evidence', 'whatsapp_history')
                     for k, s in (('table', ''), ('index', '_expires_at_idx'), ('index', '_updated_at_idx'))]
DINAMICO_NOME = re.compile(r'^create (table|index) if not exists ([a-z_][a-z0-9_]*)[\s(]', re.I)

# --- item 3: fonte própria do DDL dinâmico (OBS-1013-03) ---
FONTE_DINAMICA = 'whatsapp-neon-store.mjs'
FONTE_TABLES = re.compile(r'const TABLES=Object\.freeze\(\{(.*?)\}\);', re.S)
FONTE_TABLES_ITEM = re.compile(r'\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*("[a-z_][a-z0-9_]*")\s*(?:,|$)')
FONTE_ARRAY = re.compile(r'const ddl=Object\.values\(TABLES\)\.flatMap\(table=>\[(.*?)\]\);', re.S)
FONTE_TOKEN = re.compile(r'\s*(?:("(?:[^"\\\n]|\\[nt"\\])*")|(\+)|(,)|(table)\b)')

# --- item 4: formato ---
EXT_JS = ('.mjs', '.js', '.cjs', '.ts', '.mts', '.cts')
QUALQUER_TABELA = re.compile(r'\bcreate\s+(?:(?:global\s+|local\s+)?(?:temp|temporary|unlogged)\s+)?table\b', re.I)
QUALQUER_INDEX = re.compile(r'\bcreate\s+(?:unique\s+)?index\b', re.I)
QUALQUER_ALTER = re.compile(r'\balter\s+table\b', re.I)
INDEX_LITERAL = re.compile(r'create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?[a-z_][a-z0-9_]*\s+on\s+'
                           r'(?:only\s+)?(?:public\.)?[a-z_][a-z0-9_]*\s*(?:using\s+[a-z]+\s*)?\(', re.I)
ALTER_MULTI = re.compile(r'alter table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+((?:add column if not exists\s+[a-z_][a-z0-9_]*\s+[^,]+?)'
                         r'(?:\s*,\s*add column if not exists\s+[a-z_][a-z0-9_]*\s+[^,]+?)*)\s*', re.I)
ALTER_CLAUSULA = re.compile(r'add column if not exists\s+([a-z_][a-z0-9_]*)\s+([^,]+)', re.I)
DRILL_CREATE = 'create table ${DRILL}.%I (like public.%I)'
DRILL_CONST = 'const DRILL = "zevanory_restore_drill";'
DRILL_ATRIB = re.compile(r'\bDRILL\s*=(?!=)')
# (arquivo, chave) -> quantidade EXATA de ocorrências aceitas fora do formato que o restore captura
EXCECOES_FORMATO = {('data-backup.mjs', DRILL_CREATE): 1, ('whatsapp-neon-store.mjs', 'index+'): 2,
                    ('data-backup.mjs', 'alter:zevanory_kv_backup'): 1,
                    ('support-email-forward.mjs', 'alter:zevanory_support_inbound'): 1}
EXCECOES = {**EXCECOES_NOME, **EXCECOES_FORMATO}


def normalizar(s):
    """Igualdade integral depois de normalizar espaços (e sem o `;` final que o restore acrescenta)."""
    s = ' '.join(s.split())
    return s[:-1].rstrip() if s.endswith(';') else s


class NaoExtraivel(Exception):
    pass


def fonte_dinamica(src):
    """Lê o DDL dinâmico do próprio worker sem executá-lo. Aceita só literais de string JS ("..." com \\n \\t \\" \\\\),
    `+`, `,` e o identificador `table`; qualquer outra coisa levanta NaoExtraivel."""
    mt, ma = FONTE_TABLES.search(src), FONTE_ARRAY.search(src)
    if not mt or not ma or len(FONTE_TABLES.findall(src)) != 1 or len(FONTE_ARRAY.findall(src)) != 1:
        raise NaoExtraivel('TABLES ou o array ddl ausente/repetido')
    corpo_t, tabelas, i = mt.group(1), [], 0
    while corpo_t[i:].strip():
        m = FONTE_TABLES_ITEM.match(corpo_t, i)
        if not m or m.end() == i:
            raise NaoExtraivel(f'TABLES: trecho não literal {corpo_t[i:i + 30]!r}')
        tabelas.append(json.loads(m.group(1))); i = m.end()
    corpo_a, moldes, atual, esperando, i = ma.group(1), [], [], True, 0
    while corpo_a[i:].strip():
        m = FONTE_TOKEN.match(corpo_a, i)
        if not m or m.end() == i:
            raise NaoExtraivel(f'ddl: token não suportado {corpo_a[i:i + 30].strip()!r}')
        lit, mais, virgula, ident = m.groups()
        if lit is not None or ident is not None:
            if not esperando:
                raise NaoExtraivel('ddl: operando sem operador')
            atual.append(('lit', json.loads(lit)) if lit is not None else ('table', None)); esperando = False
        elif mais:
            if esperando:
                raise NaoExtraivel('ddl: + sem operando')
            esperando = True
        else:
            if esperando:
                raise NaoExtraivel('ddl: elemento vazio')
            moldes.append(atual); atual, esperando = [], True
        i = m.end()
    if atual:
        if esperando:
            raise NaoExtraivel('ddl: + no fim')
        moldes.append(atual)
    if not tabelas or not moldes:
        raise NaoExtraivel('ddl ou TABLES vazio')
    return [''.join(t if k == 'table' else v for k, v in molde) for t in tabelas for molde in moldes]


def comparar_dinamico(dinamico, src_fonte):
    try:
        fonte = fonte_dinamica(src_fonte)
    except NaoExtraivel as e:
        return [f'FONTE_DINAMICA_NAO_EXTRAIVEL {FONTE_DINAMICA}: {e} (adapte o extrator ou fixe sha256 sob rótulo)']
    a, b = [normalizar(s) for s in dinamico], [normalizar(s) for s in fonte]
    if a != b:
        i = next((k for k, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        return [f'DYNAMIC_DDL_DIVERGE_DA_FONTE restore={len(a)} fonte={len(b)} primeiro_diferente={i}: '
                f'{(a[i] if i < len(a) else "-")[:70]!r} != {(b[i] if i < len(b) else "-")[:70]!r}']
    return []


def fim_string(src, abre, d):
    """Índice do delimitador `d` que fecha a string JS aberta antes de `abre` (pula escapes); None se não fecha."""
    j = abre
    while j < len(src):
        if src[j] == '\\':
            j += 2; continue
        if src[j] == d:
            return j
        j += 1
    return None


def trecho_string(src, pos):
    """(delimitador, fim, texto, concatenado) da string JS que contém o comando em `pos`."""
    d = delimitador(src, pos)
    fim = fim_string(src, pos, d) if d else None
    texto = src[pos:fim] if fim is not None else src[pos:pos + 160]
    concat = fim is not None and src[fim + 1:].lstrip().startswith('+')
    return d, fim, texto, concat


def alter_redundante(texto, create):
    """Cada `add column if not exists c tipo` já está, com o mesmo tipo, no CREATE TABLE literal da tabela."""
    if not create:
        return False
    c = ' ' + normalizar(create).lower()
    for col, tipo in ALTER_CLAUSULA.findall(texto):
        if not re.search(r'[(,]\s*' + re.escape(col.lower()) + r'\s+' + re.escape(' '.join(tipo.lower().split())) + r'\s*[,)]', c):
            return False
    return True


def formato(f, src, creates, usados):
    """Item 4 para um worker/*.mjs. Devolve violações; incrementa `usados` nas exceções."""
    viol = []
    cobertos = {m.start() for m in DDL.finditer(src)} | {m.start() for m in NOME_NAO_LITERAL.finditer(src)}
    for m in QUALQUER_TABELA.finditer(src):
        if m.start() in cobertos:
            continue
        if src.startswith(DRILL_CREATE, m.start()) and (f.name, DRILL_CREATE) in EXCECOES:
            usados[(f.name, DRILL_CREATE)] += 1; continue
        viol.append(f'DDL_FORMATO_FORA_DO_RESTORE {f.name}: {src[m.start():m.start() + 50]!r} (o restore pularia este comando)')
    for m in QUALQUER_INDEX.finditer(src):
        d, fim, texto, concat = trecho_string(src, m.start())
        if d and fim is not None and not concat and '${' not in texto and INDEX_LITERAL.match(texto):
            continue
        if concat and (f.name, 'index+') in EXCECOES:
            usados[(f.name, 'index+')] += 1; continue
        viol.append(f'INDEX_NAO_LITERAL {f.name}: {texto[:60]!r}')
    for m in QUALQUER_ALTER.finditer(src):
        d, fim, texto, concat = trecho_string(src, m.start())
        cap = ALTER.match(src, m.start())
        limpo = d and fim is not None and not concat and '${' not in texto
        if limpo and cap and (fim == cap.end() or (src[cap.end()] == ';' and fim == cap.end() + 1)):
            continue
        multi = ALTER_MULTI.fullmatch(texto) if limpo else None
        chave = (f.name, 'alter:' + multi.group(1).lower()) if multi else None
        if chave in EXCECOES:
            usados[chave] += 1
            if not alter_redundante(texto, creates.get(multi.group(1).lower())):
                viol.append(f'ALTER_EXCECAO_NAO_REDUNDANTE {f.name}: {texto[:70]!r} (coluna fora do CREATE TABLE literal)')
            continue
        viol.append(f'ALTER_FORA_DO_RESTORE {f.name}: {texto[:70]!r} (interpolado, concatenado ou não capturado inteiro)')
    if f.name == 'data-backup.mjs' and DRILL_CREATE in src:
        if src.count(DRILL_CONST) != 1 or len(DRILL_ATRIB.findall(src)) != 1:
            viol.append(f'DDL_DRILL_INESPERADO {f.name}: exige uma única atribuição {DRILL_CONST!r}')
    return viol


def fora_do_alcance(worker_dir):
    """DDL em arquivo JS/TS que o restore não lê (subdiretório de worker/ ou extensão diferente de .mjs)."""
    wd, viol = pathlib.Path(worker_dir), []
    for f in sorted(p for p in wd.rglob('*') if p.is_file() and p.suffix in EXT_JS):
        if f.parent == wd and f.suffix == '.mjs':
            continue
        src = f.read_text(encoding='utf-8', errors='replace')
        for rx in (QUALQUER_TABELA, QUALQUER_INDEX, QUALQUER_ALTER):
            m = rx.search(src)
            if m:
                viol.append(f'DDL_FORA_DO_ALCANCE_DO_RESTORE {f.relative_to(wd)}: {src[m.start():m.start() + 40]!r} '
                            f'(o restore só lê worker/*.mjs)'); break
    return viol


def corpo(src, inicio, abre):
    depth = 0
    for j in range(abre, len(src)):
        if src[j] == '(':
            depth += 1
        elif src[j] == ')':
            depth -= 1
            if depth == 0:
                return src[inicio:j + 1]
    return None


def delimitador(src, inicio):
    """Delimitador JS da string onde o DDL começa (só espaço e comentário SQL /*...*/ entre ele e o `create`)."""
    p = src[:inicio].rstrip()
    while p.endswith('*/') and '/*' in p:
        p = p[:p.rfind('/*')].rstrip()
    return p[-1] if p and p[-1] in '"\'`' else None


def escanear(worker_dir, exigir_excecoes=False):
    """Escaneamento independente. Devolve (tabelas, comandos, violações)."""
    nomes, stmts, viol = [], [], []
    arquivos = sorted(pathlib.Path(worker_dir).glob('*.mjs'))
    if not arquivos:
        viol.append(f'SEM_WORKERS {worker_dir}')
    usados = {k: 0 for k in EXCECOES}
    presentes = {f.name for f in arquivos}
    for f in arquivos:
        src = f.read_text(encoding='utf-8')
        creates = {}
        for m in NOME_NAO_LITERAL.finditer(src):
            tok = m.group(1)
            chave = (f.name, '+' if tok.endswith('+') else tok)
            if chave in EXCECOES_NOME:
                usados[chave] = usados.get(chave, 0) + 1
            else:
                viol.append(f'DDL_NOME_NAO_LITERAL {f.name}: {tok!r} (o restore pularia esta tabela)')
        if f.name == 'data-backup.mjs' and ('BACKUP_TABLE' in src):
            if src.count(BACKUP_CONST) != 1 or len(BACKUP_ATRIB.findall(src)) != 1:
                viol.append(f'DDL_BACKUP_TABLE_INESPERADO {f.name}: exige uma única atribuição {BACKUP_CONST!r}')
        for m in DDL.finditer(src):
            stmt = corpo(src, m.start(), m.end() - 1)
            nome = m.group(1)
            if stmt is None:
                viol.append(f'DDL_SEM_FECHAMENTO {f.name}:{nome}'); continue
            d = delimitador(src, m.start())
            if d is None:
                viol.append(f'DDL_SEM_DELIMITADOR {f.name}:{nome} (DDL precisa abrir uma string JS)')
            elif d in stmt:
                viol.append(f'DDL_CONCATENADO {f.name}:{nome} (delimitador {d} dentro do corpo: valor concatenado)')
            if nome == '${BACKUP_TABLE}':
                nome, stmt = 'zevanory_kv_backup', stmt.replace('${BACKUP_TABLE}', 'zevanory_kv_backup')
            if '${' in stmt:
                viol.append(f'DDL_INTERPOLADO {f.name}:{nome}')
            creates.setdefault(nome.lower(), stmt)
            if nome.lower() in nomes:
                continue
            nomes.append(nome.lower())
            stmts.append(stmt + ';')
        for m in ALTER.finditer(src):
            stmts.append(m.group(0) + ';')
        viol += formato(f, src, creates, usados)
    viol += fora_do_alcance(worker_dir)
    for (arq, tok), n in EXCECOES.items():
        if (arq in presentes or exigir_excecoes) and usados[(arq, tok)] != n:
            viol.append(f'DDL_EXCECAO_FORA_DA_COTA {arq}: {tok!r} usado {usados[(arq, tok)]}x (exatamente {n})')
    return nomes, stmts, viol


PROBE = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
import restore_new_database as r
if sys.argv[2] == 'runtime':
    n, s = r.runtime_ddl(sys.argv[3])
    print('RND ' + json.dumps({'nomes': list(n), 'stmts': list(s)}))
else:
    print('RND ' + json.dumps({'dinamico': list(r.dynamic_ddl())}))
"""


def restore(modo, worker_dir=None, restore_py=RESTORE):
    """Roda a função do restore em processo separado. Devolve (rc, dados|None, cauda)."""
    cmd = [sys.executable, '-I', '-B', '-c', PROBE, str(pathlib.Path(restore_py).parent), modo] + \
          ([str(worker_dir)] if worker_dir else [])
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120)
    linhas = [l for l in p.stdout.splitlines() if l.startswith('RND ')]
    dados = json.loads(linhas[-1][4:]) if p.returncode == 0 and len(linhas) == 1 else None
    return p.returncode, dados, (p.stdout + p.stderr).strip().splitlines()[-1:] or ['']


def verificar(worker_dir, dinamico=True, restore_py=RESTORE, exigir_excecoes=False):
    nomes, stmts, viol = escanear(worker_dir, exigir_excecoes)
    rc, dados, cauda = restore('runtime', worker_dir, restore_py)
    if dados is None:
        viol.append(f'RESTORE_RUNTIME_DDL_FALHOU rc={rc}: {cauda[0][:200]}')
    else:
        if sorted(dados['nomes']) != sorted(nomes):
            viol.append(f'RESTORE_DIVERGE tabelas: so_restore={sorted(set(dados["nomes"]) - set(nomes))} '
                        f'so_gate={sorted(set(nomes) - set(dados["nomes"]))}')
        if dados['stmts'] != stmts:
            i = next((k for k, (a, b) in enumerate(zip(dados['stmts'], stmts)) if a != b), min(len(dados['stmts']), len(stmts)))
            viol.append(f'RESTORE_DIVERGE comandos: restore={len(dados["stmts"])} gate={len(stmts)} primeiro_diferente={i}')
    n_din = 0
    if dinamico:
        rc, d, cauda = restore('dynamic', restore_py=restore_py)
        if d is None:
            viol.append(f'RESTORE_DYNAMIC_DDL_FALHOU rc={rc}: {cauda[0][:200]}')
        else:
            n_din = len(d['dinamico'])
            achados = [(m.group(1).lower(), m.group(2).lower()) if m else ('?', s[:40])
                       for s, m in ((s, DINAMICO_NOME.match(s)) for s in d['dinamico'])]
            if achados != DINAMICO_ESPERADO:
                viol.append(f'DYNAMIC_DDL_INESPERADO {n_din} comandos (esperados {len(DINAMICO_ESPERADO)}): {achados[:3]}')
            viol += [f'DYNAMIC_DDL_INTERPOLADO {s[:60]!r}' for s in d['dinamico'] if '${' in s or '"+' in s]
            # OBS-1013-03: o arquivo que dynamic_ddl() executa é <raiz do restore>/worker/whatsapp-neon-store.mjs
            fonte = pathlib.Path(os.path.abspath(restore_py)).parents[2] / 'worker' / FONTE_DINAMICA
            viol += comparar_dinamico(d['dinamico'], fonte.read_text(encoding='utf-8') if fonte.is_file() else '')
    return nomes, len(stmts), n_din, viol


LIMPO = ('export async function s(sql){await sql.query("create table if not exists zz_a (id int primary key, '
         "v numeric(5,4) not null default 0.3000)\");await sql.query(`create table if not exists zz_b (id int, t text default 'x')`);"
         'await sql.query("alter table zz_a add column if not exists w text");'
         'await sql.query("create index if not exists zz_a_v_idx on zz_a (v)");}\n')
BACKUP_ALTER = 'alter table zevanory_kv_backup add column if not exists expiration bigint, add column if not exists metadata text'
BACKUP_OK = ('const BACKUP_TABLE = "zevanory_kv_backup";\nconst DRILL = "zevanory_restore_drill";\n'
             'export async function b(sql){await sql.query(`create table if not exists '
             '${BACKUP_TABLE} (k text primary key, expiration bigint, metadata text)`);\n'
             'await sql.query(`' + BACKUP_ALTER + '`);\n'
             "await sql.query(`do $$ begin execute format('create table ${DRILL}.%I (like public.%I)', 'a', 'a'); end $$`);}\n")


def com(corpo):
    return {'fixture.mjs': LIMPO + 'const R="0.3000",T="zz_a";export async function t(sql){' + corpo + '}\n'}


# nome -> ({arquivo: conteúdo}, rc esperado, código esperado)
FIXTURES = {
    'limpo': ({'fixture.mjs': LIMPO, 'data-backup.mjs': BACKUP_OK}, 0, None),
    'ddl_interpolado': ({'fixture.mjs': LIMPO + 'const R=(0.3).toFixed(4);export async function t(sql){await sql.query(`create '
                         'table if not exists zz_c (id int, rate numeric(5,4) not null default ${R})`);}\n'}, 1, 'DDL_INTERPOLADO'),
    'valor_concatenado': ({'fixture.mjs': LIMPO + 'const RATE4=(0.3).toFixed(4);export async function t(sql){await sql.query('
                           '"create table if not exists zz_c (id int, rate numeric(5,4) not null default "+RATE4+",x int)");}\n'},
                          1, 'DDL_CONCATENADO'),
    'nome_interpolado': ({'fixture.mjs': LIMPO + 'const T="zz_d";export async function t(sql){await sql.query(`create table if not '
                          'exists ${T} (id int)`);}\n'}, 1, 'DDL_NOME_NAO_LITERAL'),
    'nome_concatenado': ({'fixture.mjs': LIMPO + 'const T="zz_e";export async function t(sql){await sql.query("create table if not '
                          'exists " + T + " (id int)");}\n'}, 1, 'DDL_NOME_NAO_LITERAL'),
    'excecao_repetida': ({'fixture.mjs': LIMPO, 'data-backup.mjs': BACKUP_OK + 'export async function c(sql){await sql.query('
                          '`create table if not exists ${BACKUP_TABLE} (j text)`);}\n'}, 1, 'DDL_EXCECAO_FORA_DA_COTA'),
    'backup_table_trocado': ({'fixture.mjs': LIMPO, 'data-backup.mjs': BACKUP_OK.replace('"zevanory_kv_backup"', '"outra"')},
                             1, 'DDL_BACKUP_TABLE_INESPERADO'),
    # follow-up do #1013: ALTER / CREATE INDEX / formatos que a regex do restore pula em silêncio
    'alter_interpolado': (com('await sql.query(`alter table zz_a add column if not exists r numeric(5,4) not null default ${R}`);'),
                          1, 'ALTER_FORA_DO_RESTORE'),
    'alter_nome_interpolado': (com('await sql.query(`alter table ${T} add column if not exists c text`);'), 1, 'ALTER_FORA_DO_RESTORE'),
    'alter_concatenado': (com('await sql.query("alter table zz_a add column if not exists c text default "+R);'),
                          1, 'ALTER_FORA_DO_RESTORE'),
    'alter_default_truncado': (com("await sql.query(`alter table zz_a add column if not exists c text default 'x'`);"),
                               1, 'ALTER_FORA_DO_RESTORE'),
    'index_interpolado': (com('await sql.query(`create index if not exists zz_a_i on zz_a (${T})`);'), 1, 'INDEX_NAO_LITERAL'),
    'index_nome_interpolado': (com('await sql.query(`create index if not exists ${T}_i on zz_a (id)`);'), 1, 'INDEX_NAO_LITERAL'),
    'index_concatenado': (com('await sql.query("create index if not exists zz_a_i on zz_a (id) where v > "+R);'), 1, 'INDEX_NAO_LITERAL'),
    'index_nome_concatenado': (com('await sql.query("create index if not exists "+T+"_i on zz_a (id)");'), 1, 'INDEX_NAO_LITERAL'),
    'create_espaco_duplo': (com('await sql.query(`create  table if not exists zz_f (id int)`);'), 1, 'DDL_FORMATO_FORA_DO_RESTORE'),
    'create_sem_if_not_exists': (com('await sql.query(`create table zz_g (id int)`);'), 1, 'DDL_FORMATO_FORA_DO_RESTORE'),
    'mjs_em_subdiretorio': ({'fixture.mjs': LIMPO, 'sub/novo.mjs': 'export async function n(sql){await sql.query('
                             '`create table if not exists zz_h (id int)`);}\n'}, 1, 'DDL_FORA_DO_ALCANCE_DO_RESTORE'),
    'arquivo_js': ({'fixture.mjs': LIMPO, 'novo.js': 'export async function n(sql){await sql.query('
                    '`create table if not exists zz_i (id int)`);}\n'}, 1, 'DDL_FORA_DO_ALCANCE_DO_RESTORE'),
    'alter_multicoluna_nao_redundante': ({'fixture.mjs': LIMPO, 'data-backup.mjs': BACKUP_OK.replace(
        BACKUP_ALTER, BACKUP_ALTER + ', add column if not exists extra text')}, 1, 'ALTER_EXCECAO_NAO_REDUNDANTE'),
    'drill_trocado': ({'fixture.mjs': LIMPO, 'data-backup.mjs': BACKUP_OK.replace('"zevanory_restore_drill"', '"public"')},
                      1, 'DDL_DRILL_INESPERADO'),
}
# restore enfraquecido (cópia temporária) -> (trecho original, substituto, código esperado)
RESTORES_FRACOS = {
    'restore_so_nomes': ('    return names, stmts\n', '    return names, []\n', 'RESTORE_DIVERGE comandos'),
    'restore_um_comando_a_menos': ('    return names, stmts\n', '    return names, stmts[:-1]\n', 'RESTORE_DIVERGE comandos'),
    'restore_dinamico_fixo': ('    return [s + ";" for s in stmts]\n',
                              '    return ["create table if not exists whatsapp_stage_events (k text);"]\n', 'DYNAMIC_DDL_INESPERADO'),
    # OBS-1013-03: mesmos (tipo, nome), coluna ou restrição diferente
    'restore_dinamico_coluna_trocada': ('    return [s + ";" for s in stmts]\n',
                                        '    return [s.replace("store_value text not null", "store_value text") + ";" for s in stmts]\n',
                                        'DYNAMIC_DDL_DIVERGE_DA_FONTE'),
    'restore_dinamico_restricao_trocada': ('    return [s + ";" for s in stmts]\n',
                                           '    return [s.replace(" where expires_at is not null", "") + ";" for s in stmts]\n',
                                           'DYNAMIC_DDL_DIVERGE_DA_FONTE'),
}
# fonte dinâmica alterada (texto do worker) contra o dynamic_ddl() real -> (trecho, substituto, código esperado ou None = passa)
FONTES = {
    'fonte_real': (None, None, None),
    'fonte_coluna_alterada': ('" store_value text not null,\\n"+', '" store_value text,\\n"+', 'DYNAMIC_DDL_DIVERGE_DA_FONTE'),
    'fonte_nao_extraivel': ('+table+"_updated_at_idx on "', '+table.trim()+"_updated_at_idx on "', 'FONTE_DINAMICA_NAO_EXTRAIVEL'),
}


def restore_fraco(t, de, para):
    """Cópia de scripts/ops com o restore mutado; worker/ e data/ apontam para o repositório (dynamic_ddl usa cwd=ROOT)."""
    ops = pathlib.Path(t) / 'scripts' / 'ops'; ops.mkdir(parents=True)
    for f in ('restore_new_database.py', 'backup_preserve_archive.py'):
        shutil.copy(RESTORE.parent / f, ops / f)
    src = (ops / 'restore_new_database.py').read_text(encoding='utf-8')
    if src.count(de) != 1:
        return None
    (ops / 'restore_new_database.py').write_text(src.replace(de, para), encoding='utf-8')
    for d in ('worker', 'data'):
        os.symlink(ROOT / d, pathlib.Path(t) / d)
    return ops / 'restore_new_database.py'


def autoteste():
    ok, total = 0, len(FIXTURES) + len(RESTORES_FRACOS) + len(FONTES)
    for nome, (arquivos, esperado, codigo) in FIXTURES.items():
        with tempfile.TemporaryDirectory() as t:
            for a, src in arquivos.items():
                (pathlib.Path(t) / a).parent.mkdir(parents=True, exist_ok=True)
                (pathlib.Path(t) / a).write_text(src, encoding='utf-8')
            _, _, _, viol = verificar(t, dinamico=False)
            rc_restore, _, cauda = restore('runtime', t)
        rc = 1 if viol else 0
        certo = rc == esperado and (codigo is None or any(v.startswith(codigo) for v in viol))
        if nome == 'ddl_interpolado':  # o próprio restore também precisa recusar (fail(...) -> código 2)
            certo = certo and rc_restore == 2 and 'runtime_ddl_interpolated fixture.mjs' in cauda[0]
        print(f'RUNTIME_DDL_GATE SELFTEST {nome} esperado={esperado} rc={rc} {"ok" if certo else "ERRADO"} {viol[:2]}')
        ok += certo
    for nome, (de, para, codigo) in RESTORES_FRACOS.items():
        with tempfile.TemporaryDirectory() as t:
            fraco = restore_fraco(t, de, para)
            viol = verificar(ROOT / 'worker', restore_py=fraco)[3] if fraco else ['ANCORA_AUSENTE']
        certo = fraco is not None and any(v.startswith(codigo) for v in viol)
        print(f'RUNTIME_DDL_GATE SELFTEST {nome} esperado=1 rc={1 if viol else 0} {"ok" if certo else "ERRADO"} {viol[:2]}')
        ok += certo
    _, real, _ = restore('dynamic')
    src_fonte = (ROOT / 'worker' / FONTE_DINAMICA).read_text(encoding='utf-8')
    for nome, (de, para, codigo) in FONTES.items():
        ancora = de is None or src_fonte.count(de) == 1
        viol = comparar_dinamico(real['dinamico'], src_fonte if de is None else src_fonte.replace(de, para)) \
            if real and ancora else ['ANCORA_AUSENTE']
        certo = ancora and real is not None and (not viol if codigo is None else any(v.startswith(codigo) for v in viol))
        print(f'RUNTIME_DDL_GATE SELFTEST {nome} esperado={0 if codigo is None else 1} rc={1 if viol else 0} '
              f'{"ok" if certo else "ERRADO"} {viol[:2]}')
        ok += certo
    print(f'RUNTIME_DDL_GATE SELFTEST total={total} pass={ok}')
    return 0 if ok == total else 1


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--worker-dir', default=None)
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args(argv)
    if a.self_test:
        return autoteste()
    wd = pathlib.Path(a.worker_dir) if a.worker_dir else ROOT / 'worker'
    if not wd.is_dir() or not RESTORE.is_file():
        print(f'::error title=RUNTIME_DDL_GATE::entrada inválida ({wd})'); return 2
    # no repositório real as duas exceções precisam existir com exatamente um comando cada
    nomes, n_stmts, n_din, viol = verificar(wd, exigir_excecoes=a.worker_dir is None)
    for v in viol:
        print(f'::error title=RUNTIME_DDL_GATE::{v}')
    print(f'RUNTIME_DDL_GATE {"FAIL" if viol else "OK"} tabelas={len(nomes)} comandos={n_stmts} dinamico={n_din} violacoes={len(viol)}')
    return 1 if viol else 0


if __name__ == '__main__':
    sys.exit(main())
