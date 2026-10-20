#!/usr/bin/env python3
"""ZEVANORY | Readback FAIL-CLOSED da versão viva e da trava comercial (B01 patch 05e, contestação F2 do Sol).
Uso: live_lock_check.py --curl-rc N ARQUIVO_RESPOSTA [--print-sha | --compare-json ARQUIVO]
05f: rejeita JSON com chave duplicada (contestação A02 do Sol) e exige proveniência do commit vivo (A03): a resposta de
GET repos/{repo}/compare/{sha}...gh-pages deve ter status "ahead" ou "identical" (o commit vivo é ancestral de gh-pages).
Aprova (saída 0) SOMENTE se: a leitura HTTP teve sucesso (curl rc 0), o corpo é JSON objeto, deployment.commit_sha é
um SHA de 40 hexadecimais e sales_mode é exatamente "globally-blocked". Qualquer outra situação: saída 4 (bloqueia).
Não usa segredos. Não existe caminho de aviso que termine em 0."""
import argparse, json, re, sys

TRAVA_EXIGIDA = 'globally-blocked'

class ChaveDuplicada(ValueError):
    pass

def _sem_duplicatas(pares):
    vistos = {}
    for k, v in pares:
        if k in vistos: raise ChaveDuplicada(k)
        vistos[k] = v
    return vistos

def verificar_proveniencia(sha, corpo_compare):
    try:
        c = json.loads(corpo_compare, object_pairs_hook=_sem_duplicatas)
    except (ValueError, TypeError):
        return False, 'PROVENIENCIA_ILEGIVEL: resposta de compare inválida'
    if not isinstance(c, dict) or c.get('status') not in ('ahead', 'identical'):
        return False, f'PROVENIENCIA_NAO_COMPROVADA: commit vivo {sha} não é ancestral de gh-pages (status={c.get("status") if isinstance(c, dict) else None!r})'
    base = c.get('base_commit') if isinstance(c.get('base_commit'), dict) else {}
    if base.get('sha') != sha:
        return False, f'PROVENIENCIA_NAO_COMPROVADA: compare não corresponde ao commit vivo {sha}'
    return True, f'PROVENIENCIA_OK: {sha} ancestral de gh-pages (status={c["status"]})'

def verificar(curl_rc, corpo):
    if curl_rc != 0:
        return False, f'LEITURA_FALHOU: curl rc={curl_rc}; versão viva não comprovada'
    try:
        d = json.loads(corpo, object_pairs_hook=_sem_duplicatas)
    except ChaveDuplicada as e:
        return False, f'JSON_AMBIGUO: chave duplicada {str(e)!r} na resposta de /api/release'
    except (ValueError, TypeError):
        return False, 'JSON_INVALIDO: resposta de /api/release ilegível'
    if not isinstance(d, dict):
        return False, 'JSON_INVALIDO: resposta não é objeto'
    dep = d.get('deployment')
    sha = dep.get('commit_sha') if isinstance(dep, dict) else None
    if not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
        return False, 'COMMIT_AUSENTE: deployment.commit_sha ausente ou malformado'
    modo = d.get('sales_mode')
    if modo != TRAVA_EXIGIDA:
        return False, f'TRAVA_COMERCIAL_ABERTA_OU_DESCONHECIDA: sales_mode={modo!r} (exigido {TRAVA_EXIGIDA!r})'
    return True, f'LIVE_COMMIT={sha} SALES_MODE={modo}'

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--curl-rc', type=int, required=True); ap.add_argument('arquivo')
    g = ap.add_mutually_exclusive_group(); g.add_argument('--print-sha', action='store_true'); g.add_argument('--compare-json')
    a = ap.parse_args()
    try:
        corpo = open(a.arquivo, encoding='utf-8', errors='replace').read()
    except OSError:
        corpo = None
    ok, msg = verificar(a.curl_rc, corpo)
    if ok and a.print_sha:
        print(json.loads(corpo)['deployment']['commit_sha']); sys.exit(0)
    if ok and a.compare_json:
        try:
            cmp_corpo = open(a.compare_json, encoding='utf-8', errors='replace').read()
        except OSError:
            cmp_corpo = None
        ok, msg2 = verificar_proveniencia(json.loads(corpo)['deployment']['commit_sha'], cmp_corpo)
        msg = msg + ' | ' + msg2
    elif ok:
        ok, msg = False, msg + ' | PROVENIENCIA_NAO_VERIFICADA: use --compare-json'
    print(msg)
    sys.exit(0 if ok else 4)
