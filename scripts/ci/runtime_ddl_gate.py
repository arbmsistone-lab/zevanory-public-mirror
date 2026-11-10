#!/usr/bin/env python3
"""ZEVANORY | Gate estático do DDL de tempo de execução do Worker (contra-auditoria do #1008).

Lacuna: o #1008 pôs DDL interpolado em worker/affiliate-program.mjs. scripts/ops/restore_new_database.py (runtime_ddl, que
varre TODOS os worker/*.mjs) recusa isso, mas o check p20-restore-drill não rodou (filtro `paths` só lista alguns workers)
e não é obrigatório. Este gate roda dentro do check obrigatório "product-pages / static-audit" (os DOIS emissores:
product-pages-premerge.yml e required-status-compat.yml), sem filtro de caminho, sem Postgres e sem rede.

O que confere (fail-closed, código 1 em qualquer divergência):
  1. ESCANEAMENTO INDEPENDENTE (este arquivo, protegido pelo guarda): em cada worker/*.mjs, todo
     `create table if not exists <nome> (` tem o corpo inteiro literal (nenhum `${`); o único nome interpolado aceito é
     `${BACKUP_TABLE}` em worker/data-backup.mjs; nome montado por concatenação (`"create table if not exists " +`) só em
     worker/whatsapp-neon-store.mjs, cujo DDL é capturado executando o módulo (item 3). Qualquer outro nome interpolado ou
     concatenado seria PULADO em silêncio pelo restore (a regex de runtime_ddl não o casa) e por isso também reprova.
  2. FONTE ÚNICA: executa runtime_ddl() de scripts/ops/restore_new_database.py num processo separado e exige que ele
     termine sem erro e devolva exatamente as mesmas tabelas que o escaneamento independente (um restore enfraquecido ou
     divergente reprova aqui, não passa calado).
  3. executa dynamic_ddl() do mesmo script (node, banco falso que só registra comandos) e exige DDL não vazio e literal.
  --self-test: workers de fixture (limpo passa; DDL interpolado, nome interpolado e concatenação fora da exceção reprovam)
  verificados pelos itens 1 e 2. --worker-dir: varre outro diretório (usado pelo teste negativo do guarda).

Saída: linhas `RUNTIME_DDL_GATE ...`; código 0 = PASS, 1 = FAIL, 2 = entrada inválida."""
import argparse, json, pathlib, re, subprocess, sys, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
RESTORE = ROOT / 'scripts' / 'ops' / 'restore_new_database.py'
# mesma regex de restore_new_database.RUNTIME_DDL (a igualdade dos resultados é conferida no item 2)
DDL = re.compile(r"create table if not exists\s+(?:public\.)?(\$\{BACKUP_TABLE\}|[a-z_][a-z0-9_]*)\s*\(", re.I)
# qualquer `create table if not exists` seguido de nome que NÃO é identificador literal
NOME_NAO_LITERAL = re.compile(r"create table if not exists\s+(?:public\.)?(?![a-z_][a-z0-9_]*\s*\()(\$\{[^}]*\}|[\"'`]\s*\+|\S+)", re.I)
EXCECOES_NOME = {('data-backup.mjs', '${BACKUP_TABLE}'), ('whatsapp-neon-store.mjs', '+')}


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


def escanear(worker_dir):
    """Escaneamento independente. Devolve (tabelas, violações)."""
    nomes, viol = [], []
    arquivos = sorted(pathlib.Path(worker_dir).glob('*.mjs'))
    if not arquivos:
        viol.append(f'SEM_WORKERS {worker_dir}')
    for f in arquivos:
        src = f.read_text(encoding='utf-8')
        for m in NOME_NAO_LITERAL.finditer(src):
            tok = m.group(1)
            chave = '+' if tok.endswith('+') else tok
            if (f.name, chave) not in EXCECOES_NOME:
                viol.append(f'DDL_NOME_NAO_LITERAL {f.name}: {tok!r} (o restore pularia esta tabela)')
        for m in DDL.finditer(src):
            stmt = corpo(src, m.start(), m.end() - 1)
            if stmt is None:
                viol.append(f'DDL_SEM_FECHAMENTO {f.name}:{m.group(1)}'); continue
            nome = m.group(1)
            if nome == '${BACKUP_TABLE}':
                nome, stmt = 'zevanory_kv_backup', stmt.replace('${BACKUP_TABLE}', 'zevanory_kv_backup')
            if '${' in stmt:
                viol.append(f'DDL_INTERPOLADO {f.name}:{nome}')
            if nome.lower() not in nomes:
                nomes.append(nome.lower())
    return nomes, viol


PROBE = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
import restore_new_database as r
modo, wd = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else None)
if modo == 'runtime':
    n, s = r.runtime_ddl(wd)
    print('RND ' + json.dumps({'nomes': n, 'stmts': len(s)}))
else:
    d = r.dynamic_ddl()
    print('RND ' + json.dumps({'dinamico': d}))
"""


def restore(modo, worker_dir=None):
    """Roda a função do restore em processo separado. Devolve (rc, dados|None, cauda)."""
    cmd = [sys.executable, '-I', '-B', '-c', PROBE, str(RESTORE.parent), modo] + ([str(worker_dir)] if worker_dir else [])
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=120)
    linhas = [l for l in p.stdout.splitlines() if l.startswith('RND ')]
    dados = json.loads(linhas[-1][4:]) if p.returncode == 0 and len(linhas) == 1 else None
    return p.returncode, dados, (p.stdout + p.stderr).strip().splitlines()[-1:] or ['']


def verificar(worker_dir, dinamico=True):
    nomes, viol = escanear(worker_dir)
    rc, dados, cauda = restore('runtime', worker_dir)
    if dados is None:
        viol.append(f'RESTORE_RUNTIME_DDL_FALHOU rc={rc}: {cauda[0][:200]}')
    elif sorted(dados['nomes']) != sorted(nomes):
        viol.append(f'RESTORE_DIVERGE do escaneamento: so_restore={sorted(set(dados["nomes"]) - set(nomes))} '
                    f'so_gate={sorted(set(nomes) - set(dados["nomes"]))}')
    n_din = 0
    if dinamico:
        rc, d, cauda = restore('dynamic')
        if d is None:
            viol.append(f'RESTORE_DYNAMIC_DDL_FALHOU rc={rc}: {cauda[0][:200]}')
        else:
            n_din = len(d['dinamico'])
            if not n_din:
                viol.append('DYNAMIC_DDL_VAZIO')
            viol += [f'DYNAMIC_DDL_INTERPOLADO {s[:60]!r}' for s in d['dinamico'] if '${' in s]
    return nomes, n_din, viol


LIMPO = ('export async function s(sql){await sql.query("create table if not exists zz_a (id int primary key, '
         "v numeric(5,4) not null default 0.3000)\");await sql.query(`create table if not exists zz_b (id int, t text default 'x')`);}\n")
FIXTURES = {
    'limpo': (LIMPO, 0, None),
    'ddl_interpolado': (LIMPO + 'const R=(0.3).toFixed(4);export async function t(sql){await sql.query(`create table if not exists '
                        'zz_c (id int, rate numeric(5,4) not null default ${R})`);}\n', 1, 'DDL_INTERPOLADO'),
    'nome_interpolado': (LIMPO + 'const T="zz_d";export async function t(sql){await sql.query(`create table if not exists ${T} '
                         '(id int)`);}\n', 1, 'DDL_NOME_NAO_LITERAL'),
    'nome_concatenado': (LIMPO + 'const T="zz_e";export async function t(sql){await sql.query("create table if not exists " + T + '
                         '" (id int)");}\n', 1, 'DDL_NOME_NAO_LITERAL'),
}


def autoteste():
    ok = 0
    for nome, (src, esperado, codigo) in FIXTURES.items():
        with tempfile.TemporaryDirectory() as t:
            (pathlib.Path(t) / 'fixture.mjs').write_text(src, encoding='utf-8')
            _, _, viol = verificar(t, dinamico=False)
            rc_restore, _, cauda = restore('runtime', t)
        rc = 1 if viol else 0
        certo = rc == esperado and (codigo is None or any(v.startswith(codigo) for v in viol))
        if nome == 'ddl_interpolado':  # o próprio restore também precisa recusar (fail(...) -> código 2)
            certo = certo and rc_restore == 2 and 'runtime_ddl_interpolated fixture.mjs' in cauda[0]
        print(f'RUNTIME_DDL_GATE SELFTEST {nome} esperado={esperado} rc={rc} {"ok" if certo else "ERRADO"} {viol[:2]}')
        ok += certo
    print(f'RUNTIME_DDL_GATE SELFTEST total={len(FIXTURES)} pass={ok}')
    return 0 if ok == len(FIXTURES) else 1


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--worker-dir', default=str(ROOT / 'worker'))
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args(argv)
    if a.self_test:
        return autoteste()
    if not pathlib.Path(a.worker_dir).is_dir() or not RESTORE.is_file():
        print(f'::error title=RUNTIME_DDL_GATE::entrada inválida ({a.worker_dir})'); return 2
    nomes, n_din, viol = verificar(a.worker_dir)
    for v in viol:
        print(f'::error title=RUNTIME_DDL_GATE::{v}')
    print(f'RUNTIME_DDL_GATE {"FAIL" if viol else "OK"} tabelas={len(nomes)} dinamico={n_din} violacoes={len(viol)}')
    return 1 if viol else 0


if __name__ == '__main__':
    sys.exit(main())
