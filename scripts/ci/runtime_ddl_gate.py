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
     esperados (4 tabelas whatsapp_* e 2 índices de cada, nesta ordem), sem interpolação.
  --self-test: fixtures de worker (limpo passa; DDL interpolado, valor concatenado no corpo, nome interpolado, nome
  concatenado, exceção repetida e BACKUP_TABLE trocado reprovam) e restores enfraquecidos em cópia temporária (só nomes,
  dinâmico fixo de 1 comando, um comando a menos) que precisam reprovar no item 2/3.
  --worker-dir: varre outro diretório (teste negativo do guarda).
Fora do escopo (follow-up registrado no PR): `alter table ... add column` interpolado também é pulado pelo restore.

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
    usados = {k: 0 for k in EXCECOES_NOME}
    presentes = {f.name for f in arquivos}
    for f in arquivos:
        src = f.read_text(encoding='utf-8')
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
            if nome.lower() in nomes:
                continue
            nomes.append(nome.lower())
            stmts.append(stmt + ';')
        for m in ALTER.finditer(src):
            stmts.append(m.group(0) + ';')
    for (arq, tok), n in EXCECOES_NOME.items():
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
    return nomes, len(stmts), n_din, viol


LIMPO = ('export async function s(sql){await sql.query("create table if not exists zz_a (id int primary key, '
         "v numeric(5,4) not null default 0.3000)\");await sql.query(`create table if not exists zz_b (id int, t text default 'x')`);}\n")
BACKUP_OK = ('const BACKUP_TABLE = "zevanory_kv_backup";\nexport async function b(sql){await sql.query(`create table if not exists '
             '${BACKUP_TABLE} (k text primary key)`);}\n')
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
}
# restore enfraquecido (cópia temporária) -> (trecho original, substituto, código esperado)
RESTORES_FRACOS = {
    'restore_so_nomes': ('    return names, stmts\n', '    return names, []\n', 'RESTORE_DIVERGE comandos'),
    'restore_um_comando_a_menos': ('    return names, stmts\n', '    return names, stmts[:-1]\n', 'RESTORE_DIVERGE comandos'),
    'restore_dinamico_fixo': ('    return [s + ";" for s in stmts]\n',
                              '    return ["create table if not exists whatsapp_stage_events (k text);"]\n', 'DYNAMIC_DDL_INESPERADO'),
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
    ok, total = 0, len(FIXTURES) + len(RESTORES_FRACOS)
    for nome, (arquivos, esperado, codigo) in FIXTURES.items():
        with tempfile.TemporaryDirectory() as t:
            for a, src in arquivos.items():
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
