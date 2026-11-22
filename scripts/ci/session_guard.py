#!/usr/bin/env python3
"""ZEVANORY | session-guard (22/11/2026, r2). Roda SOMENTE código da base, via pull_request_target.

Lê como DADO os commits e o corpo do PR (coletados pela API) e decide se toda sessão Claude declarada consta em
ops/executor.json DA BASE. O PR não altera a lista nem esta decisão: workflow, script e lista vêm da base.

Mesma revisão (r2): o PR é lido ANTES e DEPOIS da lista de commits. Reprova se o head mudar durante a coleta (mesmo
com a mesma contagem), se o head lido não for o head do evento, se o último commit da lista não for esse head, se a
contagem divergir, se o corpo mudar entre as duas leituras ou se o PR tiver mais commits do que a API lista (250).

Falha fechada também para: lista inválida ou vazia, nenhuma sessão declarada, sessão fora da lista, JSON ilegível.
Uma declaração é texto, não autenticação; o controle decisivo continua sendo a revisão e o merge do titular.
Só biblioteca padrão. Saída: JSON em stdout. Código: 0 PASS, 1 FAIL.
"""
import argparse
import json
import re
import sys

SESSAO = re.compile(r'session_[A-Za-z0-9]{8,}')
SESSAO_EXATA = re.compile(r'^session_[A-Za-z0-9]{8,}$')
SHA = re.compile(r'^[0-9a-f]{40}$')
LIMITE_API_COMMITS = 250


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


def commits(caminho):
    with open(caminho, encoding='utf-8') as f:
        d = json.load(f)
    if not isinstance(d, list):
        raise ValueError('lista de commits ilegível')
    itens = []
    for p in d:  # gh api --paginate --slurp -> lista de páginas
        itens.extend(p if isinstance(p, list) else [p])
    out = []
    for c in itens:
        sha = c.get('sha') if isinstance(c, dict) else None
        msg = c.get('commit', {}).get('message') if isinstance(c, dict) else None
        if not isinstance(sha, str) or not SHA.match(sha) or not isinstance(msg, str):
            raise ValueError('commit sem sha ou mensagem legível')
        out.append((sha, msg))
    return out


def pr(caminho):
    with open(caminho, encoding='utf-8') as f:
        d = json.load(f)
    head = (d.get('head') or {}).get('sha') if isinstance(d, dict) else None
    n = d.get('commits') if isinstance(d, dict) else None
    corpo = d.get('body') if isinstance(d, dict) else None
    if not isinstance(head, str) or not SHA.match(head) or not isinstance(n, int):
        raise ValueError('PR sem head.sha ou contagem de commits')
    return {'head': head, 'commits': n, 'body': corpo or '', 'base': (d.get('base') or {}).get('sha')}


def mesma_revisao(evento_head, antes, depois, lista):
    """Retorna None se commits e corpo são da mesma revisão do evento; senão o motivo."""
    if not SHA.match(evento_head or ''):
        return {'reason': 'EVENT_HEAD_INVALID'}
    if antes['head'] != depois['head']:
        return {'reason': 'HEAD_CHANGED_DURING_COLLECTION', 'antes': antes['head'], 'depois': depois['head']}
    if depois['head'] != evento_head:
        return {'reason': 'HEAD_NOT_EVENT_HEAD', 'api': depois['head'], 'evento': evento_head}
    if antes['body'] != depois['body']:
        return {'reason': 'BODY_CHANGED_DURING_COLLECTION'}
    if antes['commits'] != depois['commits']:
        return {'reason': 'COMMIT_COUNT_CHANGED_DURING_COLLECTION'}
    if depois['commits'] > LIMITE_API_COMMITS:
        return {'reason': 'TOO_MANY_COMMITS_FOR_API', 'commits': depois['commits']}
    if len(lista) != depois['commits']:
        return {'reason': 'COMMIT_COUNT_MISMATCH', 'lidos': len(lista), 'esperados': depois['commits']}
    if not lista or lista[-1][0] != evento_head:
        return {'reason': 'COMMIT_LIST_NOT_AT_HEAD', 'ultimo': lista[-1][0] if lista else None, 'evento': evento_head}
    if len({s for s, _ in lista}) != len(lista):
        return {'reason': 'COMMIT_LIST_DUPLICATED'}
    return None


def avaliar(permitidas, msgs, corpo):
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
    ap.add_argument('--pr-before', required=True, help='GET pulls/N antes da lista de commits')
    ap.add_argument('--pr-after', required=True, help='GET pulls/N depois da lista de commits')
    ap.add_argument('--event-head-sha', required=True)
    ap.add_argument('--base-sha', default='')
    a = ap.parse_args(argv)
    r = {}
    try:
        permitidas = carregar_lista(a.executor)
        lista = commits(a.commits)
        antes, depois = pr(a.pr_before), pr(a.pr_after)
        problema = mesma_revisao(a.event_head_sha, antes, depois, lista)
        if problema:
            r = {'verdict': 'FAIL', **problema}
        else:
            r = avaliar(permitidas, [m for _, m in lista], depois['body'])
            r['revision_checked'] = {'head': depois['head'], 'commits': len(lista), 'body_stable': True}
    except (OSError, ValueError, json.JSONDecodeError, AttributeError) as e:
        r = {'verdict': 'FAIL', 'reason': 'INPUT_ERROR', 'detail': str(e)[:200]}
    r.update({'schema': 'zevanory.session-guard.v2', 'list_source': 'base', 'base_sha': a.base_sha,
              'event_head_sha': a.event_head_sha})
    print(json.dumps(r, ensure_ascii=False, sort_keys=True))
    return 0 if r['verdict'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
