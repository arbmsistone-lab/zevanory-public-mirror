#!/usr/bin/env python3
"""ZEVANORY | G4 (Ordem 082, achado do Sol): guarda dos checks obrigatórios.

Os checks obrigatórios de gh-pages ("product-pages / static-audit" e "zees16-evidence / fail-closed") são emitidos por
workflows `pull_request`, que executam a versão DO PR do workflow e dos scripts. Um PR podia, portanto, fazer o próprio
check obrigatório passar. Este guarda roda via `pull_request_target` (definição e checkout da BASE), trata o PR só como
DADO (lista de arquivos e YAML lidos pela API, parseados com BaseLoader, nunca executados) e falha quando:

  DURO (nenhum rótulo libera):
    - um workflow do PR emite job com nome de check obrigatório fora do emissor canônico (colisão de nome);
    - o emissor canônico é enfraquecido: job removido/renomeado, `if:` no job ou em passo, `continue-on-error`,
      gatilho `pull_request` removido ou com filtro de caminho/branch que deixa o check "pendente"/"skipped";
    - arquivo que sombreia módulo da biblioteca padrão onde os scripts obrigatórios importam (raiz, scripts/, scripts/ci/);
    - YAML de workflow inválido, nome de arquivo inesperado ou lista de arquivos truncada.
  BRANDO (liberado só por rótulo do proprietário preso ao SHA exato do head):
    - qualquer alteração em caminho protegido (.github/**, scripts/ci/**, scripts dos checks obrigatórios, políticas e
      tests/ci/**). Rótulo exigido: owner-approved:<12 primeiros hex do head SHA>, aplicado por login em OWNERS
      (verificado no histórico de eventos do PR). Novo push muda o SHA e invalida o rótulo.

Uso: required_check_guard.py --files files.json --head-workflows DIR --head-sha SHA --labels labels.json
                             --events events.json [--expected-count N]
Saída: JSON. Código 0 = PASS, 1 = FAIL, 2 = entrada inválida (fail-closed)."""
import argparse, json, pathlib, re, sys

try:
    import yaml
except ImportError:  # pragma: no cover - runner do GitHub tem python3-yaml
    print(json.dumps({'resultado': 'FAIL', 'erro': 'pyyaml ausente'})); sys.exit(2)

GUARD_NAME = 'required-check-guard / protected-paths'
OWNERS = frozenset({'arbmsistone-lab'})
LABEL_PREFIX = 'owner-approved:'

# check obrigatório -> {arquivo canônico: job_id}. Qualquer outro emissor do mesmo nome é colisão.
REQUIRED_CHECKS = {
    'product-pages / static-audit': {'product-pages-premerge.yml': 'audit', 'required-status-compat.yml': 'product-status'},
    'zees16-evidence / fail-closed': {'required-status-compat.yml': 'zees-status'},
    GUARD_NAME: {'required-check-guard.yml': 'guard'},
}
# gatilho que cada emissor canônico precisa manter (sem filtros que pulem o check)
TRIGGER = {'product-pages-premerge.yml': 'pull_request', 'required-status-compat.yml': 'pull_request',
           'required-check-guard.yml': 'pull_request_target'}

REQUIRED_SCRIPTS = (
    'scripts/premerge_product_audit.py', 'scripts/zevanory_10p_excellence_gate.py', 'scripts/zevanory_crown_gate.py',
    'scripts/test_crown_negative.py', 'scripts/zees16_evidence_gate.py',
)
PROTECTED = [re.compile(p) for p in (
    r'^\.github/',                       # workflows, CODEOWNERS, actions locais, dependabot
    r'^scripts/ci/',                     # guarda, avaliador de impacto e utilitários de CI
    r'^tests/ci/',                       # testes/mutantes da governança
    r'^compliance/zevanory-(10p|crown)-policy\.json$',  # políticas lidas pelos gates obrigatórios
    r'^(CODEOWNERS|docs/CODEOWNERS)$',   # locais alternativos do CODEOWNERS
)] + [re.compile('^' + re.escape(s) + '$') for s in REQUIRED_SCRIPTS]

# diretórios onde um módulo plantado seria importado pelos scripts obrigatórios (sys.path[0] = scripts/ ou scripts/ci/;
# scripts/test_crown_negative.py insere a raiz do repositório em sys.path[0])
SHADOW_DIRS = ('', 'scripts/', 'scripts/ci/')
EXTRA_SHADOW = {'__init__', 'sitecustomize', 'usercustomize', 'yaml', '_yaml'}
STDLIB = set(getattr(sys, 'stdlib_module_names', ())) or {
    'json', 're', 'sys', 'os', 'pathlib', 'hashlib', 'datetime', 'html', 'urllib', 'argparse', 'subprocess', 'typing',
    'collections', 'functools', 'itertools', 'io', 'tempfile', 'unittest', 'textwrap', 'string', 'stat', 'shutil'}
NOME_SEGURO = re.compile(r'^[A-Za-z0-9._/@+-][A-Za-z0-9._/@+ -]*$')


def protegido(caminho):
    return any(p.search(caminho) for p in PROTECTED)


def sombreia(caminho):
    for d in SHADOW_DIRS:
        if not caminho.startswith(d):
            continue
        resto = caminho[len(d):]
        if resto.startswith('__pycache__/'):
            return True
        ext = re.compile(r'\.(py|pyc|pyo|pyd|so|pth)$')
        primeiro = resto.split('/', 1)[0]
        if '/' in resto:
            # diretório-pacote: só sombreia com código importável dentro (sem __init__ é namespace e perde para a stdlib)
            if not ext.search(resto):
                continue
            modulo = primeiro
        else:
            modulo = ext.sub('', primeiro)
            if modulo == primeiro:
                continue  # arquivo sem extensão importável
        if modulo in STDLIB or modulo in EXTRA_SHADOW:
            return True
    return False


def gatilhos(y):
    on = y.get('on', y.get(True))
    if isinstance(on, str): return {on: {}}
    if isinstance(on, list): return {str(k): {} for k in on}
    return on if isinstance(on, dict) else {}


def _padrao_nome(nome):
    """Nome de job com expressão ${{ }} pode virar qualquer texto em tempo de execução."""
    partes = re.split(r'\$\{\{.*?\}\}', nome)
    return re.compile('.*'.join(re.escape(p) for p in partes) + r'\Z', re.S)


def analisar_workflow(arquivo, texto):
    """Violações DURAS de um workflow do PR (lido como dado)."""
    v = []
    try:
        y = yaml.load(texto, Loader=yaml.BaseLoader)
    except yaml.YAMLError as e:
        return [f'WORKFLOW_YAML_INVALIDO {arquivo}: {str(e).splitlines()[0]}']
    if not isinstance(y, dict):
        return [f'WORKFLOW_YAML_INVALIDO {arquivo}: raiz não é mapeamento']
    jobs = y.get('jobs') if isinstance(y.get('jobs'), dict) else {}
    nomes_por_job = {}
    for jid, job in jobs.items():
        job = job if isinstance(job, dict) else {}
        nome = str(job.get('name', jid))
        nomes_por_job[jid] = nome
        rx = _padrao_nome(nome) if '${{' in nome else None
        for check, canon in REQUIRED_CHECKS.items():
            casa = (rx.match(check) is not None) if rx else (nome.strip() == check)
            if casa and canon.get(arquivo) != jid:
                v.append(f'COLISAO_DE_NOME {arquivo}:{jid} emite {check!r} fora do emissor canônico')
        if isinstance(job.get('uses'), str):
            # workflow reutilizável: os nomes dos jobs chamados viram "<nome> / <job>"; recusa se puder colidir
            for check in REQUIRED_CHECKS:
                if check.startswith(nome.strip() + ' / ') and canon_de(check).get(arquivo) != jid:
                    v.append(f'COLISAO_DE_NOME {arquivo}:{jid} (reutilizável) pode emitir {check!r}')
    # emissor canônico: não pode ser enfraquecido
    for check, canon in REQUIRED_CHECKS.items():
        jid = canon.get(arquivo)
        if jid is None:
            continue
        if jid not in jobs:
            v.append(f'JOB_OBRIGATORIO_REMOVIDO {arquivo}:{jid} ({check})'); continue
        job = jobs[jid] if isinstance(jobs[jid], dict) else {}
        if nomes_por_job.get(jid, '').strip() != check:
            v.append(f'JOB_OBRIGATORIO_RENOMEADO {arquivo}:{jid} deixou de emitir {check!r}')
        if 'if' in job:
            v.append(f'JOB_OBRIGATORIO_CONDICIONAL {arquivo}:{jid} (job pulado conta como sucesso)')
        if 'continue-on-error' in job:
            v.append(f'JOB_OBRIGATORIO_CONTINUE_ON_ERROR {arquivo}:{jid}')
        if 'needs' in job:
            v.append(f'JOB_OBRIGATORIO_COM_NEEDS {arquivo}:{jid} (dependência falha pula o job = sucesso)')
        if 'strategy' in job:
            v.append(f'JOB_OBRIGATORIO_COM_MATRIZ {arquivo}:{jid}')
        if 'uses' in job:
            v.append(f'JOB_OBRIGATORIO_DELEGADO {arquivo}:{jid}')
        for i, passo in enumerate(job.get('steps') or []):
            if isinstance(passo, dict):
                for chave in ('if', 'continue-on-error'):
                    if chave in passo:
                        v.append(f'PASSO_OBRIGATORIO_{chave.upper().replace("-", "_")} {arquivo}:{jid} passo {i}')
    if arquivo in TRIGGER:
        ev = TRIGGER[arquivo]
        g = gatilhos(y)
        if ev not in g:
            v.append(f'GATILHO_OBRIGATORIO_REMOVIDO {arquivo}: sem {ev}')
        if ev in g:
            cfg = g.get(ev) if isinstance(g.get(ev), dict) else {}
            for chave in ('paths', 'paths-ignore', 'branches-ignore'):
                if chave in cfg:
                    v.append(f'GATILHO_OBRIGATORIO_FILTRADO {arquivo}: {ev}.{chave} deixa o check pendente/ausente')
            br = cfg.get('branches')
            if br is not None:
                br = br if isinstance(br, list) else [br]
                if 'gh-pages' not in [str(b) for b in br]:
                    v.append(f'GATILHO_OBRIGATORIO_FILTRADO {arquivo}: {ev}.branches sem gh-pages')
            tipos = cfg.get('types')
            if tipos is not None:
                tipos = tipos if isinstance(tipos, list) else [tipos]
                faltam = {'opened', 'synchronize', 'reopened'} - {str(t) for t in tipos}
                if faltam:
                    v.append(f'GATILHO_OBRIGATORIO_FILTRADO {arquivo}: {ev}.types sem {sorted(faltam)}')
    return v


def canon_de(check):
    return REQUIRED_CHECKS.get(check, {})


def achatar(paginas):
    return [x for p in paginas for x in (p if isinstance(p, list) else [p])]


def aprovado(head_sha, labels, eventos):
    rotulo = LABEL_PREFIX + head_sha[:12]
    if rotulo not in labels:
        return False, f'rótulo {rotulo!r} ausente'
    ultimo = None
    for e in eventos:
        if e.get('event') in ('labeled', 'unlabeled') and (e.get('label') or {}).get('name') == rotulo:
            ultimo = e
    if not ultimo or ultimo.get('event') != 'labeled':
        return False, f'rótulo {rotulo!r} sem evento "labeled" correspondente'
    ator = (ultimo.get('actor') or {}).get('login')
    if ator not in OWNERS:
        return False, f'rótulo {rotulo!r} aplicado por {ator!r}, fora de OWNERS'
    return True, f'rótulo {rotulo!r} aplicado por {ator}'


def avaliar(arquivos, head_wf, head_sha, labels, eventos, esperado=None):
    duro, brando = [], []
    if not re.fullmatch(r'[0-9a-f]{40}', head_sha or ''):
        duro.append(f'HEAD_SHA_INVALIDO {head_sha!r}')
    if esperado is not None and esperado != len(arquivos):
        duro.append(f'LISTA_TRUNCADA esperado={esperado} recebido={len(arquivos)} (API limita a 3000 arquivos)')
    caminhos, removidos = [], set()
    for x in arquivos:
        nomes = [x.get('filename')] + ([x.get('previous_filename')] if x.get('status') == 'renamed' else [])
        for n in nomes:
            if not isinstance(n, str) or not NOME_SEGURO.match(n) or '..' in n.split('/') or n.startswith('/'):
                duro.append(f'NOME_INESPERADO {n!r}'); continue
            caminhos.append(n)
        if x.get('status') == 'removed' or x.get('status') == 'renamed':
            removidos.add(x.get('previous_filename') if x.get('status') == 'renamed' else x.get('filename'))
    caminhos = list(dict.fromkeys(caminhos))
    for c in caminhos:
        if sombreia(c):
            duro.append(f'SOMBRA_DE_MODULO {c} (sequestraria import dos scripts obrigatórios)')
        if protegido(c):
            brando.append(c)
    for r in removidos:
        base = r.rsplit('/', 1)[-1]
        if r.startswith('.github/workflows/') and base in TRIGGER:
            duro.append(f'EMISSOR_OBRIGATORIO_REMOVIDO {r}')
    for arquivo, texto in sorted(head_wf.items()):
        duro += analisar_workflow(arquivo, texto)
    ok_aprov, motivo = aprovado(head_sha or '', labels, eventos) if brando else (False, 'não necessário')
    passou = not duro and (not brando or ok_aprov)
    return {'resultado': 'PASS' if passou else 'FAIL', 'head_sha': head_sha,
            'violacoes_duras': duro, 'caminhos_protegidos_alterados': brando,
            'aprovacao_do_proprietario': {'valida': ok_aprov, 'motivo': motivo,
                                          'rotulo_exigido': LABEL_PREFIX + (head_sha or '')[:12] if brando else None}}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--files', required=True); ap.add_argument('--head-workflows', required=True)
    ap.add_argument('--head-sha', required=True); ap.add_argument('--labels', required=True)
    ap.add_argument('--events', required=True); ap.add_argument('--expected-count', type=int)
    a = ap.parse_args(argv)
    try:
        arquivos = achatar(json.load(open(a.files)))
        labels = [l['name'] if isinstance(l, dict) else str(l) for l in achatar(json.load(open(a.labels)))]
        eventos = achatar(json.load(open(a.events)))
        head_wf = {f.name: f.read_text(errors='replace') for f in sorted(pathlib.Path(a.head_workflows).glob('*'))
                   if f.is_file()}
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(json.dumps({'resultado': 'FAIL', 'erro': f'entrada inválida: {e}'}, ensure_ascii=False)); return 2
    r = avaliar(arquivos, head_wf, a.head_sha, labels, eventos, a.expected_count)
    print(json.dumps(r, ensure_ascii=False, indent=1))
    return 0 if r['resultado'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
