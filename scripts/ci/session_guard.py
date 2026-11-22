#!/usr/bin/env python3
"""ZEVANORY | session-guard (22/11/2026). Roda SOMENTE código da base, via pull_request_target.

Lê como DADO os commits e o corpo do PR (coletados pela API) e decide se toda sessão Claude declarada consta em
ops/executor.json DA BASE. O PR não altera a lista nem esta decisão: workflow, script e lista vêm da base.
Falha fechada: lista inválida ou vazia, nenhuma sessão declarada, sessão fora da lista, contagem de commits
divergente do evento (paginação truncada) ou JSON ilegível -> reprova. Uma declaração é texto, não autenticação;
o controle decisivo continua sendo a revisão e o merge do titular. Só biblioteca padrão.
Saída: JSON em stdout. Código: 0 PASS, 1 FAIL.
"""
import argparse
import json
import re
import sys

SESSAO = re.compile(r'session_[A-Za-z0-9]{8,}')
SESSAO_EXATA = re.compile(r'^session_[A-Za-z0-9]{8,}$')


def carregar_lista(caminho):
    with open(caminho, encoding='utf-8') as f:
        d = json.load(f)
    lista = d.get('authorized_claude_sessions') if isinstance(d, dict) else None
    if not isinstance(lista, list) or not lista:
        raise ValueError('authorized_claude_sessions ausente ou vazia')
    if any(not isinstance(s, str) or not SESSAO_EXATA.match(s) for s in lista):
        raise ValueError('authorized_claude_sessions com item fora do formato session_<id>')
    if len(set(lista)) != len(lista):
        raise ValueError('authorized_claude_sessions com item repetido')
    return set(lista)


def mensagens(caminho):
    with open(caminho, encoding='utf-8') as f:
        d = json.load(f)
    paginas = d if isinstance(d, list) else []
    itens = []
    for p in paginas:  # gh api --paginate --slurp -> lista de páginas
        itens.extend(p if isinstance(p, list) else [p])
    out = []
    for c in itens:
        msg = (c or {}).get('commit', {}).get('message') if isinstance(c, dict) else None
        if not isinstance(msg, str):
            raise ValueError('commit sem mensagem legível')
        out.append(msg)
    return out


def avaliar(permitidas, msgs, corpo, esperado):
    if esperado is not None and len(msgs) != esperado:
        return {'verdict': 'FAIL', 'reason': 'COMMIT_COUNT_MISMATCH', 'lidos': len(msgs), 'esperados': esperado}
    declaradas = sorted(set(SESSAO.findall('\n'.join(msgs) + '\n' + (corpo or ''))))
    if not declaradas:
        return {'verdict': 'FAIL', 'reason': 'EXECUTOR_IDENTITY_NOT_ESTABLISHED', 'declared': []}
    fora = [s for s in declaradas if s not in permitidas]
    if fora:
        return {'verdict': 'FAIL', 'reason': 'UNAUTHORISED_EXECUTOR_SESSION', 'declared': declaradas, 'unauthorised': fora}
    return {'verdict': 'PASS', 'reason': 'DECLARED_SESSIONS_AUTHORISED_BY_BASE', 'declared': declaradas}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--executor', required=True, help='ops/executor.json do checkout da BASE')
    ap.add_argument('--commits', required=True)
    ap.add_argument('--body', required=True)
    ap.add_argument('--expected-commits', type=int)
    ap.add_argument('--base-sha', default='')
    ap.add_argument('--head-sha', default='')
    a = ap.parse_args(argv)
    try:
        permitidas = carregar_lista(a.executor)
        msgs = mensagens(a.commits)
        with open(a.body, encoding='utf-8') as f:
            corpo = f.read()
        r = avaliar(permitidas, msgs, corpo, a.expected_commits)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        r = {'verdict': 'FAIL', 'reason': 'INPUT_ERROR', 'detail': str(e)[:200]}
    r.update({'schema': 'zevanory.session-guard.v1', 'list_source': 'base', 'base_sha': a.base_sha, 'head_sha': a.head_sha})
    print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    return 0 if r['verdict'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
