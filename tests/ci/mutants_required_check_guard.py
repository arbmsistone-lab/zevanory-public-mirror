#!/usr/bin/env python3
"""G4: testes de mutação do guarda (scripts/ci/required_check_guard.py), com classificação HONESTA.

Correção da AVAL 090 (Sol): a versão anterior contava qualquer código de saída != 0 como "MORTO"; sem PyYAML instalado
todos os mutantes eram falsamente mortos. Agora:

  1. PRÉ-CHECAGEM de dependências (tests/ci/requirements-guard.txt) no MESMO interpretador que roda a suíte.
     Ausente -> execução inteira INCONCLUSIVO (fail-closed), nenhum mutante é classificado.
  2. CONTROLE (baseline): a suíte roda contra o guarda NÃO mutado; precisa passar com relatório completo.
     Falhou / sem relatório -> execução inteira INCONCLUSIVO.
  3. Cada mutante é MORTO (KILLED) somente se uma ASSERÇÃO da suíte falhar num teste ESPERADO para aquele mutante e a
     mensagem casar com o padrão esperado. Asserção levantada dentro do código sob teste não conta.
     Erro de import, dependência ausente, sintaxe, timeout, erro de coleta, relatório ausente/incompleto, exceção que não é
     asserção ou falha só em teste não esperado -> INCONCLUSIVO, nunca MORTO.
     Exceção que não é asserção só conta como morte se estiver em CAUSAL_ALLOWLIST (vazia: nenhum caso justificado).
  4. VIVO (SURVIVED): relatório completo, todos os testes do baseline executados e aprovados, código de saída 0.

Uso: python3 -I -B tests/ci/mutants_required_check_guard.py <RAIZ_DO_REPO> [--timeout S] [--json SAIDA.json]
Saída: 0 = baseline válido e todos MORTOS; 1 = algum VIVO; 2 = INCONCLUSIVO (baseline, dependência ou algum mutante)."""
import json, pathlib, re, subprocess, sys, tempfile

AQUI = pathlib.Path(__file__).resolve().parent
KILLED, SURVIVED, INCONCLUSIVE = 'KILLED', 'SURVIVED', 'INCONCLUSIVE'
T = 'test_'
PASS_FAIL = r"'PASS' != 'FAIL'|'FAIL' != 'PASS'"  # resultado do guarda trocado (assertEqual em ok()/falha())

# módulo importável -> nome declarado em tests/ci/requirements-guard.txt (teste do executor confere o espelho)
DEPENDENCIAS = {'yaml': 'PyYAML'}

# mutante -> (trecho original, substituto, {teste esperado: regex da mensagem de asserção})
MUTANTES = {
    'M01_aprova_sempre': ("passou = not duro and (not brando or ok_aprov)", "passou = True",
                          {T + 'T02_editar_workflow_obrigatorio_sem_rotulo_falha': PASS_FAIL}),
    'M02_rotulo_libera_violacao_dura': ("passou = not duro and (not brando or ok_aprov)",
                                        "passou = (not duro and not brando) or ok_aprov",
                                        {T + 'T08_novo_workflow_com_mesmo_nome_de_check_falha_mesmo_com_rotulo': PASS_FAIL}),
    'M03_rotulo_sem_sha': ("rotulo = LABEL_PREFIX + head_sha[:12]",
                           "rotulo = next((l for l in labels if l.startswith(LABEL_PREFIX)), LABEL_PREFIX)",
                           {T + 'T04_rotulo_de_outro_sha_falha': PASS_FAIL}),
    'M04_qualquer_ator': ("if ator not in OWNERS:", "if False:", {T + 'T05_rotulo_aplicado_por_nao_dono_falha': PASS_FAIL}),
    'M05_ignora_unlabeled': ("if not ultimo or ultimo.get('event') != 'labeled':", "if not ultimo:",
                             {T + 'T06_rotulo_removido_ou_sem_evento_falha': PASS_FAIL}),
    'M06_sem_colisao': ("if casa and canon.get(arquivo) != jid:", "if False:",
                        {T + 'T08_novo_workflow_com_mesmo_nome_de_check_falha_mesmo_com_rotulo': PASS_FAIL}),
    'M07_sem_nome_dinamico': ("rx = _padrao_nome(nome) if '${{' in nome else None", "rx = None",
                              {T + 'T09_nome_dinamico_que_pode_colidir_falha': r'COLISAO_DE_NOME ausente|' + PASS_FAIL}),
    'M08_permite_if_no_job': ("if 'if' in job:", "if False:", {T + 'T11_job_obrigatorio_condicional_falha': PASS_FAIL}),
    'M09_permite_if_em_passo': ("for chave in ('if', 'continue-on-error'):", "for chave in ('continue-on-error',):",
                                {T + 'T12_passo_condicional_ou_continue_on_error_falha': PASS_FAIL}),
    'M10_permite_filtro_paths': ("for chave in ('paths', 'paths-ignore', 'branches-ignore'):", "for chave in ():",
                                 {T + 'T13_filtro_de_caminho_ou_gatilho_removido_falha': PASS_FAIL}),
    'M11_permite_remover_gatilho': ("if ev not in g:", "if False:",
                                    {T + 'T13_filtro_de_caminho_ou_gatilho_removido_falha': r'GATILHO_OBRIGATORIO_REMOVIDO ausente|' + PASS_FAIL}),
    'M12_github_desprotegido': ("r'^\\.github/',", "", {T + 'T07_scripts_e_politicas_dos_checks_sao_protegidos': PASS_FAIL}),
    'M13_scripts_obrigatorios_desprotegidos': ("+ [re.compile('^' + re.escape(s) + '$') for s in REQUIRED_SCRIPTS]", "",
                                               {T + 'T07_scripts_e_politicas_dos_checks_sao_protegidos': PASS_FAIL}),
    'M14_sem_sombra': ("def sombreia(caminho):\n", "def sombreia(caminho):\n    return False\n",
                       {T + 'T16_sombra_de_modulo_falha': PASS_FAIL}),
    'M15_sem_truncamento': ("if esperado is not None and esperado != len(arquivos):", "if False:",
                            {T + 'T17_lista_truncada_yaml_invalido_nome_inesperado_falha': r'LISTA_TRUNCADA ausente|' + PASS_FAIL}),
    'M16_ignora_renomeado': ("([x.get('previous_filename')] if x.get('status') == 'renamed' else [])", "[]",
                             {T + 'T15_emissor_removido_ou_renomeado_falha': PASS_FAIL}),
    'M17_permite_remover_emissor': ("if r.startswith('.github/workflows/') and base in TRIGGER:", "if False:",
                                    {T + 'T15_emissor_removido_ou_renomeado_falha': r'EMISSOR_OBRIGATORIO_REMOVIDO ausente|' + PASS_FAIL}),
    'M18_permite_renomear_job': ("if nomes_por_job.get(jid, '').strip() != check:", "if False:",
                                 {T + 'T14_job_renomeado_ou_removido_falha': r'JOB_OBRIGATORIO_RENOMEADO ausente|' + PASS_FAIL}),
    'M19_yaml_invalido_passa': ("return [f'WORKFLOW_YAML_INVALIDO {arquivo}: {str(e).splitlines()[0]}']", "return []",
                                {T + 'T17_lista_truncada_yaml_invalido_nome_inesperado_falha': r'WORKFLOW_YAML_INVALIDO ausente|' + PASS_FAIL}),
    'M20_continue_on_error_job': ("if 'continue-on-error' in job:", "if False:",
                                  {T + 'T12_passo_condicional_ou_continue_on_error_falha': r'JOB_OBRIGATORIO_CONTINUE_ON_ERROR ausente|' + PASS_FAIL}),
}

# mutante -> {(teste, tipo da exceção)} aceitos como morte causal mesmo sem ser asserção. VAZIA de propósito: nenhum caso
# foi justificado; preencher exige explicar por que aquela exceção só pode ser causada pela defesa removida.
CAUSAL_ALLOWLIST = {}


def checar_dependencias(python):
    """Retorna (ok, detalhe). Roda no mesmo interpretador/flags usados pela suíte."""
    faltam, versoes = [], {}
    for mod, pacote in DEPENDENCIAS.items():
        p = subprocess.run(python + ['-c', f'import {mod}; print(getattr({mod}, "__version__", "?"))'],
                           capture_output=True, text=True, timeout=60)
        if p.returncode != 0:
            faltam.append(pacote)
        else:
            versoes[pacote] = p.stdout.strip()
    if faltam:
        return False, f'DEPENDENCIA_AUSENTE {faltam} (instalar: pip install -r tests/ci/requirements-guard.txt)'
    return True, versoes


def rodar_suite(python, suite, repo, guarda, timeout):
    """Executa a suíte contra `guarda` e devolve (relatorio|None, rc|None, motivo|None)."""
    with tempfile.TemporaryDirectory() as d:
        rel = pathlib.Path(d) / 'relatorio.json'
        try:
            p = subprocess.run(python + ['-B', str(suite), str(repo), '--guard', str(guarda), '--json-report', str(rel)],
                               capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, None, f'TIMEOUT >{timeout}s'
        if not rel.is_file():
            cauda = (p.stderr.strip().splitlines() or p.stdout.strip().splitlines() or [''])[-1][:300]
            return None, p.returncode, f'SEM_RELATORIO rc={p.returncode} (import/sintaxe/dependência/coleta): {cauda}'
        try:
            dados = json.loads(rel.read_text())
            assert dados.get('schema') == 'g4-suite-report/1' and isinstance(dados.get('testes'), dict)
        except (ValueError, AssertionError):
            return None, p.returncode, f'RELATORIO_INVALIDO rc={p.returncode}'
        return dados, p.returncode, None


def classificar(nome, rel, rc, motivo, ids_baseline, esperados):
    """Classificação de UM mutante a partir do relatório da suíte. Devolve (estado, detalhe)."""
    if rel is None:
        return INCONCLUSIVE, motivo
    testes = rel['testes']
    if set(testes) != ids_baseline or rel.get('testes_executados') != len(ids_baseline):
        return INCONCLUSIVE, f'COLETA_DIFERENTE do baseline ({len(testes)} vs {len(ids_baseline)})'
    falhas = {t: v for t, v in testes.items() if v['resultado'] == 'falha'}
    erros = {t: v for t, v in testes.items() if v['resultado'] in ('erro', 'pulado')}
    if not falhas and not erros:
        if rc != 0:
            return INCONCLUSIVE, f'TODOS_OK_MAS_RC={rc}'
        return SURVIVED, 'todos os testes passaram'
    if rc == 0:
        return INCONCLUSIVE, 'RC=0_COM_FALHAS (relatório incoerente)'
    permitidos = CAUSAL_ALLOWLIST.get(nome, set())
    erros_nao_causais = {t: v for t, v in erros.items() if (t.rsplit('.', 1)[-1], v.get('tipo')) not in permitidos}
    if erros_nao_causais:
        t, v = next(iter(sorted(erros_nao_causais.items())))
        return INCONCLUSIVE, f'ERRO_NAO_ASSERCAO {t.rsplit(".", 1)[-1]}: {v.get("tipo")} {v.get("mensagem", "")[:160]}'
    acertos = [t.rsplit('.', 1)[-1] for t, v in falhas.items()
               if t.rsplit('.', 1)[-1] in esperados and re.search(esperados[t.rsplit('.', 1)[-1]], v.get('mensagem', ''))]
    acertos += [t.rsplit('.', 1)[-1] for t, v in erros.items() if (t.rsplit('.', 1)[-1], v.get('tipo')) in permitidos]
    if not acertos:
        return INCONCLUSIVE, f'FALHA_FORA_DO_ESPERADO {sorted(t.rsplit(".", 1)[-1] for t in falhas)}'
    extras = sorted(t.rsplit('.', 1)[-1] for t in falhas if t.rsplit('.', 1)[-1] not in acertos)
    return KILLED, f'asserção em {sorted(acertos)}' + (f'; também falharam {extras}' if extras else '')


def executar(repo, guarda_src=None, mutantes=None, python=None, timeout=120, verificar_dependencias=True):
    """Executa controle + mutantes. `guarda_src` (texto) e `mutantes` permitem os autotestes do executor."""
    repo = pathlib.Path(repo).resolve()
    python = list(python or [sys.executable, '-I'])
    suite = repo / 'tests/ci/test_required_check_guard.py'
    src = guarda_src if guarda_src is not None else (repo / 'scripts/ci/required_check_guard.py').read_text()
    mutantes = MUTANTES if mutantes is None else mutantes
    out = {'baseline': None, 'dependencias': None, 'mutantes': {}, 'resultado': INCONCLUSIVE}

    def todos_inconclusivos(motivo):
        out['mutantes'] = {n: {'estado': INCONCLUSIVE, 'detalhe': motivo} for n in mutantes}
        return out

    if verificar_dependencias:
        ok, det = checar_dependencias(python)
        out['dependencias'] = det
        if not ok:
            out['baseline'] = {'estado': INCONCLUSIVE, 'detalhe': det}
            return todos_inconclusivos('não executado: ' + det)
    with tempfile.TemporaryDirectory() as d:
        g = pathlib.Path(d) / 'required_check_guard.py'
        g.write_text(src)
        rel, rc, motivo = rodar_suite(python, suite, repo, g, timeout)
        if rel is None or rc != 0 or not rel.get('sucesso') or not rel['testes'] or \
                any(v['resultado'] != 'ok' for v in rel['testes'].values()):
            det = motivo or 'BASELINE_FALHOU: ' + ', '.join(sorted(t.rsplit('.', 1)[-1] for t, v in rel['testes'].items()
                                                                  if v['resultado'] != 'ok'))
            out['baseline'] = {'estado': INCONCLUSIVE, 'detalhe': det}
            return todos_inconclusivos('não classificável: baseline inválido')
        ids = set(rel['testes'])
        out['baseline'] = {'estado': 'PASS', 'detalhe': f'{len(ids)} testes aprovados no guarda não mutado'}
        for nome, (de, para, esperados) in mutantes.items():
            if src.count(de) < 1:
                out['mutantes'][nome] = {'estado': INCONCLUSIVE, 'detalhe': 'TRECHO_NAO_ENCONTRADO'}; continue
            g.write_text(src.replace(de, para, 1))
            rel, rc, motivo = rodar_suite(python, suite, repo, g, timeout)
            estado, det = classificar(nome, rel, rc, motivo, ids, esperados)
            out['mutantes'][nome] = {'estado': estado, 'detalhe': det}
    estados = [m['estado'] for m in out['mutantes'].values()]
    out['resultado'] = SURVIVED if SURVIVED in estados else (INCONCLUSIVE if INCONCLUSIVE in estados or not estados else KILLED)
    return out


def main(argv):
    if not argv or argv[0].startswith('-'):
        print(__doc__, file=sys.stderr); return 2
    repo, timeout, saida = argv[0], 120, None
    if '--timeout' in argv: timeout = int(argv[argv.index('--timeout') + 1])
    if '--json' in argv: saida = argv[argv.index('--json') + 1]
    r = executar(repo, timeout=timeout)
    print(f"dependências: {r['dependencias']}")
    print(f"baseline (guarda não mutado): {r['baseline']['estado']} — {r['baseline']['detalhe']}\n")
    print('| Mutante | Classificação | Evidência |\n|---|---|---|')
    for n, m in r['mutantes'].items():
        print(f"| {n} | {m['estado']} | {m['detalhe'].replace('|', '/')} |")
    cont = {e: sum(1 for m in r['mutantes'].values() if m['estado'] == e) for e in (KILLED, SURVIVED, INCONCLUSIVE)}
    print(f"\nmutantes: {len(r['mutantes'])} KILLED: {cont[KILLED]} SURVIVED: {cont[SURVIVED]} "
          f"INCONCLUSIVE: {cont[INCONCLUSIVE]} — resultado: {r['resultado']}")
    if saida:
        pathlib.Path(saida).write_text(json.dumps(r, ensure_ascii=False, indent=1))
    return {KILLED: 0, SURVIVED: 1}.get(r['resultado'], 2)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
