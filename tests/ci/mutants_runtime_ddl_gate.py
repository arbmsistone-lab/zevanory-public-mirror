#!/usr/bin/env python3
"""Mutantes do gate de DDL do Worker (scripts/ci/runtime_ddl_gate.py), mortos pelo próprio --self-test.

Classificação honesta (mesmo critério da AVAL 090): o baseline (gate sem mutação) precisa dar
`SELFTEST total=N pass=N` com código 0. Cada mutante é MORTO só se o --self-test terminar com código != 0, imprimir a
linha final de contagem (sem crash) e marcar ERRADO exatamente no caso esperado. Código 0 = VIVO. Qualquer outra coisa
(crash, timeout, âncora ausente, ERRADO só em caso não esperado) = INCONCLUSIVO.

Uso: python3 -I -B tests/ci/mutants_runtime_ddl_gate.py <RAIZ_DO_REPO>
Saída: linha `MUTANTS total=N killed=N survived=0 inconclusive=0`; código 0 só se todos MORTOS."""
import os, pathlib, re, subprocess, sys, tempfile

# mutante -> (trecho original, substituto, caso do --self-test que precisa ficar ERRADO)
MUTANTES = {
    'G01_valor_concatenado_no_corpo_aceito': ('elif d in stmt:', 'elif False:', 'valor_concatenado'),
    'G02_interpolacao_no_corpo_aceita': ("if '${' in stmt:", 'if False:', 'ddl_interpolado'),
    'G03_restore_comparado_so_por_nomes': ("if dados['stmts'] != stmts:", 'if False:', 'restore_so_nomes'),
    'G04_dinamico_so_nao_vazio': ('if achados != DINAMICO_ESPERADO:', 'if not achados:', 'restore_dinamico_fixo'),
    'G05_excecao_sem_cota_exata': ('usados[(arq, tok)] != n:', 'usados[(arq, tok)] < n:', 'excecao_repetida'),
    'G06_backup_table_sem_valor': ('if src.count(BACKUP_CONST) != 1 or len(BACKUP_ATRIB.findall(src)) != 1:',
                                   'if len(BACKUP_ATRIB.findall(src)) != 1:', 'backup_table_trocado'),
    'G07_excecao_vale_em_qualquer_arquivo': ('if chave in EXCECOES_NOME:', "if chave[1] in ('+', '${BACKUP_TABLE}'):",
                                             'nome_concatenado'),
}


def rodar(repo, src):
    """Roda o --self-test de `src` numa árvore temporária (scripts/ops, worker e data apontam para o repositório)."""
    with tempfile.TemporaryDirectory() as t:
        t = pathlib.Path(t)
        (t / 'scripts' / 'ci').mkdir(parents=True)
        (t / 'scripts' / 'ci' / 'runtime_ddl_gate.py').write_text(src, encoding='utf-8')
        os.symlink(repo / 'scripts' / 'ops', t / 'scripts' / 'ops')
        for d in ('worker', 'data'):
            os.symlink(repo / d, t / d)
        try:
            p = subprocess.run([sys.executable, '-I', '-B', str(t / 'scripts/ci/runtime_ddl_gate.py'), '--self-test'],
                               capture_output=True, text=True, timeout=300)
        except subprocess.TimeoutExpired:
            return None, ''
        return p.returncode, p.stdout


def main(argv):
    repo = pathlib.Path(argv[1] if len(argv) > 1 else '.').resolve()
    original = (repo / 'scripts/ci/runtime_ddl_gate.py').read_text(encoding='utf-8')
    rc, out = rodar(repo, original)
    m = re.search(r'^RUNTIME_DDL_GATE SELFTEST total=(\d+) pass=(\d+)$', out, re.M)
    if rc != 0 or not m or m.group(1) != m.group(2):
        print(f'BASELINE INCONCLUSIVE rc={rc} {out[-400:]}')
        print(f'MUTANTS total={len(MUTANTES)} killed=0 survived=0 inconclusive={len(MUTANTES)}')
        return 2
    print(f'BASELINE ok total={m.group(1)}')
    cont = {'KILLED': 0, 'SURVIVED': 0, 'INCONCLUSIVE': 0}
    for nome, (de, para, caso) in MUTANTES.items():
        if original.count(de) != 1:
            estado, det = 'INCONCLUSIVE', 'âncora ausente ou repetida'
        else:
            rc, out = rodar(repo, original.replace(de, para))
            errados = re.findall(r'^RUNTIME_DDL_GATE SELFTEST (\S+) .* ERRADO ', out, re.M)
            final = re.search(r'^RUNTIME_DDL_GATE SELFTEST total=\d+ pass=\d+$', out, re.M)
            if rc == 0:
                estado, det = 'SURVIVED', 'self-test passou'
            elif rc == 1 and final and caso in errados:
                estado, det = 'KILLED', f'ERRADO em {errados}'
            else:
                estado, det = 'INCONCLUSIVE', f'rc={rc} errados={errados} final={bool(final)}'
        cont[estado] += 1
        print(f'| {nome} | {estado} | {det} |')
    print(f'MUTANTS total={len(MUTANTES)} killed={cont["KILLED"]} survived={cont["SURVIVED"]} inconclusive={cont["INCONCLUSIVE"]}')
    return 0 if cont['KILLED'] == len(MUTANTES) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
