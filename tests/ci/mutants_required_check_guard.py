#!/usr/bin/env python3
"""G4: testes de mutação do guarda. Cada mutante enfraquece uma defesa; a suíte precisa MATAR (falhar) todos.
Uso: python3 -I tests/ci/mutants_required_check_guard.py <RAIZ_DO_REPO>"""
import pathlib, subprocess, sys, tempfile

REPO = pathlib.Path(sys.argv[1]).resolve()
SRC = (REPO / 'scripts/ci/required_check_guard.py').read_text()
SUITE = REPO / 'tests/ci/test_required_check_guard.py'
MUTANTES = {
    'M01_aprova_sempre': ("passou = not duro and (not brando or ok_aprov)", "passou = True"),
    'M02_rotulo_libera_violacao_dura': ("passou = not duro and (not brando or ok_aprov)", "passou = (not duro and not brando) or ok_aprov"),
    'M03_rotulo_sem_sha': ("rotulo = LABEL_PREFIX + head_sha[:12]", "rotulo = next((l for l in labels if l.startswith(LABEL_PREFIX)), LABEL_PREFIX)"),
    'M04_qualquer_ator': ("if ator not in OWNERS:", "if False:"),
    'M05_ignora_unlabeled': ("if not ultimo or ultimo.get('event') != 'labeled':", "if not ultimo:"),
    'M06_sem_colisao': ("if casa and canon.get(arquivo) != jid:", "if False:"),
    'M07_sem_nome_dinamico': ("rx = _padrao_nome(nome) if '${{' in nome else None", "rx = None"),
    'M08_permite_if_no_job': ("if 'if' in job:", "if False:"),
    'M09_permite_if_em_passo': ("for chave in ('if', 'continue-on-error'):", "for chave in ('continue-on-error',):"),
    'M10_permite_filtro_paths': ("for chave in ('paths', 'paths-ignore', 'branches-ignore'):", "for chave in ():"),
    'M11_permite_remover_gatilho': ("if ev not in g:", "if False:"),
    'M12_github_desprotegido': ("r'^\\.github/',", ""),
    'M13_scripts_obrigatorios_desprotegidos': ("+ [re.compile('^' + re.escape(s) + '$') for s in REQUIRED_SCRIPTS]", ""),
    'M14_sem_sombra': ("def sombreia(caminho):\n", "def sombreia(caminho):\n    return False\n"),
    'M15_sem_truncamento': ("if esperado is not None and esperado != len(arquivos):", "if False:"),
    'M16_ignora_renomeado': ("([x.get('previous_filename')] if x.get('status') == 'renamed' else [])", "[]"),
    'M17_permite_remover_emissor': ("if r.startswith('.github/workflows/') and base in TRIGGER:", "if False:"),
    'M18_permite_renomear_job': ("if nomes_por_job.get(jid, '').strip() != check:", "if False:"),
    'M19_yaml_invalido_passa': ("return [f'WORKFLOW_YAML_INVALIDO {arquivo}: {str(e).splitlines()[0]}']", "return []"),
    'M20_continue_on_error_job': ("if 'continue-on-error' in job:", "if False:"),
}
vivos = []
for nome, (de, para) in MUTANTES.items():
    assert SRC.count(de) >= 1, f'{nome}: trecho não encontrado'
    with tempfile.TemporaryDirectory() as d:
        m = pathlib.Path(d) / 'required_check_guard.py'; m.write_text(SRC.replace(de, para, 1))
        p = subprocess.run([sys.executable, '-I', '-B', str(SUITE), str(REPO), '--guard', str(m)], capture_output=True, text=True)
        estado = 'MORTO' if p.returncode != 0 else 'VIVO'
        if estado == 'VIVO': vivos.append(nome)
        print(f'{nome}: {estado}')
print(f'mutantes: {len(MUTANTES)} mortos: {len(MUTANTES) - len(vivos)} vivos: {vivos}')
sys.exit(1 if vivos else 0)
