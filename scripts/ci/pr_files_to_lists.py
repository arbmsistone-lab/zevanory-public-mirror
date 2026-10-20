#!/usr/bin/env python3
"""ZEVANORY | B01 patch 05f (contestação A04 do Sol). Converte a resposta paginada de GET pulls/{n}/files (gh api --paginate
--slurp) em changed.txt, removed.txt e workflows_head.txt. Arquivo renomeado: o caminho antigo entra em changed e em removed
(sai da definição efetiva), o novo entra em changed. Nomes fora do padrão seguro abortam (fail-closed)."""
import json, re, sys
SEGURO = re.compile(r'^\.github/workflows/[A-Za-z0-9._-]+\.ya?ml$')

def converter(paginas):
    itens = [x for p in paginas for x in (p if isinstance(p, list) else [p])]
    changed, removed, wf = [], [], []
    for x in itens:
        nome, st = x['filename'], x['status']
        changed.append(nome)
        if st == 'removed': removed.append(nome)
        if st == 'renamed' and x.get('previous_filename'):
            changed.append(x['previous_filename']); removed.append(x['previous_filename'])
        if st != 'removed' and nome.startswith('.github/workflows/') and nome.endswith(('.yml', '.yaml')):
            if not SEGURO.match(nome): raise ValueError(f'nome de workflow inesperado: {nome!r}')
            wf.append(nome)
    u = lambda l: list(dict.fromkeys(l))
    return u(changed), u(removed), u(wf)

if __name__ == '__main__':
    entrada, saida = sys.argv[1], sys.argv[2]
    c, r, w = converter(json.load(open(entrada)))
    for nome, l in (('changed.txt', c), ('removed.txt', r), ('workflows_head.txt', w)):
        open(f'{saida}/{nome}', 'w').write(''.join(f'{x}\n' for x in l))
    print(len(c), len(r), len(w))
