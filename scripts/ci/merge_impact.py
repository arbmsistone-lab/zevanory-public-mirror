#!/usr/bin/env python3
"""ZEVANORY | Avaliador de impacto de merge (B01 patch 05h; origem 05d). Executa SOMENTE código da branch base (pull_request_target),
trata o conteúdo do PR como DADO (YAML lido com BaseLoader, nunca executado) e não usa segredos.
Entrada: --base-workflows DIR  --changed ARQUIVO(lista de caminhos alterados)  [--head-workflows DIR (YAML do PR, como dado)]
Saída: JSON com disparos diretos (push em gh-pages), cadeia indireta (workflow_run), sinais de risco; código 3 se o merge
dispara algum workflow com risco (classe B: exige lista anexada à autorização do proprietário)."""
import argparse, json, pathlib, re, sys, yaml

RISCO = {
    # 05h (contestação C01 do Sol): acesso por ponto E por índice (secrets.X e secrets['X'])
    'segredos': re.compile(r'\$\{\{[^}]*\bsecrets\s*(\.|\[)'),
    'permissao_escrita': re.compile(r'^\s*(contents|actions|deployments|packages|pull-requests|issues|statuses|checks|id-token|pages|security-events)\s*:\s*write\b', re.M),
    'oidc_id_token': re.compile(r'id-token\s*:\s*write'),
    'workflow_reutilizavel': re.compile(r'^\s*uses:\s*[^\s]+/\.github/workflows/', re.M),
    'deploy': re.compile(r'wrangler(@[\d.]+)?\s+(deploy|versions\s+(upload|deploy)|secret\s+put|kv\s+key\s+put)|\bdeploy\b', re.I),
    'financeiro': re.compile(r'mercadopago|mercado_pago|stripe|asaas|hotmart|payment', re.I),
}

def carregar(d):
    wf = {}
    if d and pathlib.Path(d).is_dir():
        for f in sorted(pathlib.Path(d).glob('*.y*ml')):
            texto = f.read_text(errors='replace')
            try: y = yaml.load(texto, Loader=yaml.BaseLoader) or {}
            except yaml.YAMLError: y = {}
            wf[f.name] = (y if isinstance(y, dict) else {}, texto)
    return wf

def gatilhos(y):
    on = y.get('on')
    if isinstance(on, str): return {on: {}}
    if isinstance(on, list): return {k: {} for k in on}
    return on if isinstance(on, dict) else {}

def _glob_re(padrao):
    """Filtro do GitHub Actions (cheat sheet oficial): "*" zero+ caracteres exceto "/"; "**" zero+ de qualquer caractere;
    "?" zero ou um do caractere ANTERIOR; "+" um ou mais do caractere ANTERIOR; "[...]" um caractere da lista ou faixa;
    "\\" escapa o caractere seguinte. 05g: contestações B01–B03 do Sol."""
    r, i, n, atomo = '', 0, len(padrao), False
    while i < n:
        c = padrao[i]
        if c == '\\' and i + 1 < n:
            r += re.escape(padrao[i + 1]); i += 2; atomo = True; continue
        if padrao.startswith('**', i):
            r += '.*'; i += 2; atomo = True
            if i < n and padrao[i] == '/': r += '(?:/)?'; i += 1; atomo = False
            continue
        if c == '*':
            r += '[^/]*'; i += 1; atomo = True; continue
        if c in '?+':
            r += c if atomo else re.escape(c); i += 1; atomo = False; continue
        if c == '[':
            j = padrao.find(']', i + 1)
            if j > i + 1:
                corpo = padrao[i + 1:j]
                if re.fullmatch(r'(?:[A-Za-z0-9._-]|[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9])+', corpo):
                    r += '[' + corpo.replace('\\', '') + ']'; i = j + 1; atomo = True; continue
            r += re.escape(c); i += 1; atomo = True; continue
        r += re.escape(c); i += 1; atomo = True
    return re.compile(r + r'\Z')

def _lista(v):
    return [] if v is None else (v if isinstance(v, list) else [v])

def casa_filtro(valor, padroes):
    """Avaliação em ordem com negação "!": o último padrão que casa decide (regra do GitHub)."""
    res = False
    for p in _lista(padroes):
        p = str(p)
        if p.startswith('!'):
            if _glob_re(p[1:]).match(valor): res = False
        elif _glob_re(p).match(valor): res = True
    return res

def dispara_por_push(y, alterados):
    push = gatilhos(y).get('push')
    if push is None: return False
    push = push if isinstance(push, dict) else {}
    if 'branches' in push and not casa_filtro('gh-pages', push.get('branches')): return False
    if 'branches-ignore' in push and casa_filtro('gh-pages', push.get('branches-ignore')): return False
    if 'paths' in push:
        return any(casa_filtro(c, push.get('paths')) for c in alterados)
    if 'paths-ignore' in push:
        return any(not casa_filtro(c, push.get('paths-ignore')) for c in alterados)
    return True

# Arquivos que mudam O QUE o Pages publica ou COMO publica (05g, contestações B04–B05 do Sol): sempre elevam.
CONFIG_PAGES = re.compile(r'^(\.nojekyll|CNAME|_config[^/]*\.ya?ml|Gemfile(\.lock)?|\.well-known/.*)$')

def publicado_pelo_pages(caminho):
    """Conservador: tudo o que não está em diretório/arquivo oculto (".") afeta a publicação — inclusive "_*" (layouts,
    includes, dados e configuração do Jekyll entram no build) — e os arquivos de configuração do Pages sempre afetam."""
    if CONFIG_PAGES.match(caminho): return True
    return not any(c.startswith('.') for c in caminho.split('/'))

def avaliar(base, head, alterados, removidos=()):
    # definição efetiva após o merge: workflows do PR (como dado) substituem os da base; removidos pelo PR saem
    efetivo = {n: v for n, v in base.items() if f'.github/workflows/{n}' not in removidos}
    efetivo.update(head or {})
    diretos = sorted(n for n, (y, _) in efetivo.items() if dispara_por_push(y, alterados))
    nomes = {n: (y.get('name') or n) for n, (y, _) in efetivo.items()}
    indiretos, fila, vistos = [], list(diretos), set(diretos)
    while fila:
        atual = fila.pop(0); nome_atual = nomes.get(atual, atual)
        for n, (y, _) in efetivo.items():
            wr = gatilhos(y).get('workflow_run')
            if not isinstance(wr, dict): continue
            ups = wr.get('workflows') or []
            ups = ups if isinstance(ups, list) else [ups]
            if nome_atual in ups and n not in vistos:
                vistos.add(n); fila.append(n); indiretos.append({'workflow': n, 'acionado_por': atual})
    def riscos(n, _pilha=()):
        y, texto = efetivo[n]
        r = {k for k, rx in RISCO.items() if rx.search(texto)}
        # 05h (contestações C02 e C05 do Sol): lidos da ESTRUTURA, valem em YAML compacto ou em bloco.
        for j in (y.get('jobs') or {}).values():
            if not isinstance(j, dict): continue
            if j.get('secrets') is not None: r.add('segredos')  # "inherit" ou mapeamento explícito para o chamado
            uses = j.get('uses')
            if isinstance(uses, str) and uses.strip():
                r.add('workflow_reutilizavel')
                m = re.match(r'^\./\.github/workflows/([A-Za-z0-9._-]+\.ya?ml)$', uses.strip())
                if not m: r.add('workflow_reutilizavel_externo')
                elif m.group(1) not in efetivo: r.add('workflow_reutilizavel_ausente')
                elif m.group(1) not in _pilha and m.group(1) != n:
                    r |= {x for x in riscos(m.group(1), _pilha + (n,))}  # efeitos do chamado entram no chamador

        # permissões lidas da ESTRUTURA (cobre estilo em bloco e em fluxo, nível de workflow e de job)
        blocos = [y.get('permissions')] + [j.get('permissions') for j in (y.get('jobs') or {}).values() if isinstance(j, dict)]
        for b in blocos:
            if b == 'write-all': r.add('permissao_escrita')
            if isinstance(b, dict):
                if any(str(v).strip() == 'write' for v in b.values()): r.add('permissao_escrita')
                if str(b.get('id-token', '')).strip() == 'write': r.add('oidc_id_token')
        if y.get('permissions') is None and not all(isinstance(j, dict) and j.get('permissions') is not None for j in (y.get('jobs') or {}).values()):
            r.add('permissoes_padrao_do_repositorio')
        return sorted(r)
    rel = {'alterados': alterados,
           'disparos_diretos': [{'workflow': n, 'riscos': riscos(n)} for n in diretos],
           'disparos_indiretos_workflow_run': [dict(i, riscos=riscos(i['workflow'])) for i in indiretos]}
    # GitHub Pages (pages-build-deployment, evento "dynamic") republica o site estático em TODO push em gh-pages.
    # Não aparece em .github/workflows; é informado sempre para não ser omitido (lição C-118). Não eleva a classe
    # sozinho: publicação estática é efeito inerente de qualquer merge em gh-pages.
    rel['efeitos_fora_dos_yaml'] = ['pages-build-deployment (GitHub Pages, evento dynamic): republica o site estático']
    # 05f (contestação T4 do Sol): merge que altera conteúdo efetivamente publicado eleva a classe
    rel['conteudo_publicado_alterado'] = sorted(c for c in alterados if publicado_pelo_pages(c))
    rel['com_risco'] = sorted({x['workflow'] for x in rel['disparos_diretos'] + rel['disparos_indiretos_workflow_run'] if x['riscos']}
                              | ({'pages-build-deployment'} if rel['conteudo_publicado_alterado'] else set()))
    rel['classe'] = 'B' if rel['com_risco'] else 'A'
    return rel

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--base-workflows', required=True); ap.add_argument('--changed', required=True)
    ap.add_argument('--head-workflows'); ap.add_argument('--removed'); a = ap.parse_args()
    alterados = [l.strip() for l in open(a.changed) if l.strip()]
    head = carregar(a.head_workflows) if a.head_workflows else {}
    removidos = [l.strip() for l in open(a.removed) if l.strip()] if a.removed else []
    rel = avaliar(carregar(a.base_workflows), head, alterados, removidos)
    print(json.dumps(rel, ensure_ascii=False, indent=1))
    sys.exit(3 if rel['classe'] == 'B' else 0)
