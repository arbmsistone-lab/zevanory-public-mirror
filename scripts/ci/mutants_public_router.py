#!/usr/bin/env python3
"""Mutantes B02 (PR #866): cada mutante altera uma CÓPIA temporária do workflow ou do script de rotas, roda
tests/test_public_router_deploy.py contra ela (ROUTER_WORKFLOW / DISCOVERY_WORKFLOW / ROUTER_ROUTES_SCRIPT) e o
original nunca é modificado. Mutantes rodam em paralelo e com -f (para no primeiro teste que falha). Imprime uma linha `MUTANT <id> KILLED|SURVIVED` por mutante e sai != 0 se algum sobreviver ou se a
suíte sem mutação não passar. Uso: python3 scripts/ci/mutants_public_router.py [raiz-do-repo]
"""
import os, re, subprocess, sys, tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
R = (REPO / ".github/workflows/public-router-deploy.yml").read_text()
D = (REPO / ".github/workflows/zpc-cloudflare-route-discovery.yml").read_text()
S = (REPO / "scripts/ops/router_routes.py").read_text()
TARGET = {"R": ("ROUTER_WORKFLOW", "wf.yml"), "D": ("DISCOVERY_WORKFLOW", "wf.yml"), "S": ("ROUTER_ROUTES_SCRIPT", "router_routes.py")}


def drop_step(text, name):
    lines = text.split("\n")
    i = next(k for k, l in enumerate(lines) if l.strip() == f"- name: {name}")
    j = i + 1
    while j < len(lines) and not lines[j].startswith("      - ") and not re.match(r"^\S", lines[j]):
        j += 1
    return "\n".join(lines[:i] + lines[j:])


def sub(text, old, new):
    assert old in text, old
    return text.replace(old, new, 1)


M = {
    "M1a remove account guard step": ("R", lambda: drop_step(R, "Account guard (fail closed before any deploy)")),
    "M1b neutralize account API check": ("R", lambda: sub(sub(R, 'if [ "$code" != "200" ]; then\n            echo "::error title=ROUTER_ACCOUNT_GUARD::GET', 'if false; then\n            echo "::error title=ROUTER_ACCOUNT_GUARD::GET'),
                                                    'if ! python3 - "$T/router-account.json"', 'if false && python3 - "$T/router-account.json"')),
    "M2a remove rollback step": ("R", lambda: drop_step(R, "Automatic rollback to the recorded version (certified by readback)")),
    "M2b rollback without wrangler rollback": ("R", lambda: sub(R, 'if ! npx --yes wrangler@4.135.0 rollback "$PREV_VERSION_ID"', 'if ! true rollback "$PREV_VERSION_ID"')),
    "M3a accept rollback readback mismatch": ("R", lambda: sub(R, '[ "$now" != "$PREV_VERSION_ID" ]', 'false')),
    "M3b accept deploy readback = previous version": ("R", lambda: sub(R, 'and vid != sys.argv[2] ', '')),
    "M3c accept public readback failure": ("R", lambda: sub(R, '[ "$final" = "200 https://vendas.zevanory.api.br/solucoes" ]', 'true')),
    "M4a print raw wrangler log (tee)": ("R", lambda: sub(R, '--tag "$GITHUB_SHA" --message "ZEVANORY public router $GITHUB_SHA" > "$T/router-deploy.log" 2>&1', '--tag "$GITHUB_SHA" --message "ZEVANORY public router $GITHUB_SHA" 2>&1 | tee "$T/router-deploy.log"')),
    "M4b cat raw wrangler log on failure": ("R", lambda: sub(R, 'echo "::error title=ROUTER_DEPLOY_FAILED::codes=${codes:-none}"', 'cat "$T/router-deploy.log"; echo "::error title=ROUTER_DEPLOY_FAILED::codes=${codes:-none}"')),
    "M4c cat raw rollback log": ("R", lambda: sub(R, 'echo "ROLLBACK_COMMAND_FAILED=1 codes=${codes:-none}"', 'cat "$T/router-rollback.log"; echo "ROLLBACK_COMMAND_FAILED=1 codes=${codes:-none}"')),
    "M5a revert discovery account default": ("D", lambda: sub(D, "      CLOUDFLARE_ACCOUNT_ID: 1b26415802588185a86c1d4d3ebf5bdb", "      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID || 'e3caca88f4343c3cdfcf66eebe6ac124' }}")),
    "M5b neutralize discovery account refusal": ("D", lambda: sub(D, 'if [ "${CLOUDFLARE_ACCOUNT_ID:-}" != "$EXPECTED_ACCOUNT_ID" ] || [ "$EXPECTED_ACCOUNT_ID" != "1b26415802588185a86c1d4d3ebf5bdb" ]; then', 'if false; then')),
    "M6 remove environment producao-critica": ("R", lambda: sub(R, "    environment: producao-critica  # B01 M1: segredos só no Environment (gh-pages)\n", "")),
    "M7 deploy without --tag SHA": ("R", lambda: sub(R, '--tag "$GITHUB_SHA" ', '')),
    "M8 no token sanitization in guard": ("R", lambda: sub(R, 'CLOUDFLARE_API_TOKEN="$(printf \'%s\' "${CLOUDFLARE_API_TOKEN:-}" | tr -d \'[:space:]\')"; export CLOUDFLARE_API_TOKEN\n          if [ -z "$CLOUDFLARE_API_TOKEN" ]', 'if [ -z "$CLOUDFLARE_API_TOKEN" ]')),
    "M9 no rollback point captured": ("R", lambda: sub(R, 'echo "PREV_VERSION_ID=$prev" >> "$GITHUB_ENV"', 'true')),
    "M10 readback default with a single attempt": ("R", lambda: sub(R, '${ROUTER_READBACK_ATTEMPTS:-12}', '${ROUTER_READBACK_ATTEMPTS:-1}')),
    "M11 readback ignores injected interval": ("R", lambda: sub(R, 'sleep "$pause"', 'sleep 5')),
    # Mutante independente (pedido do auditor, autor distinto dos 18 acima): a leitura de volta do deploy consulta
    # as implantações de OUTRA conta (a antiga e3caca88…). Só a linha do passo Readback (indentação de 14 espaços).
    "M12 deploy readback reads deployments of another account": ("R", lambda: sub(R,
        '              "https://api.cloudflare.com/client/v4/accounts/$ROUTER_ACCOUNT_ID/workers/scripts/$ROUTER_SCRIPT/deployments"',
        '              "https://api.cloudflare.com/client/v4/accounts/e3caca88f4343c3cdfcf66eebe6ac124/workers/scripts/$ROUTER_SCRIPT/deployments"')),
    # --- Rotas (achado do Sol: o rollback devolve a versão, não as rotas) ---
    "M13 rollback skips the route restore": ("R", lambda: sub(R, 'if python3 scripts/ops/router_routes.py restore "$ROUTES_SNAPSHOT"; then routes_ok=1; fi', 'routes_ok=1')),
    "M14 no route verification after deploy": ("R", lambda: drop_step(R, "Verify full route inventory after deploy (all patterns; other scripts untouched)")),
    "M15 snapshot failure tolerated": ("R", lambda: sub(R, 'python3 scripts/ops/router_routes.py snapshot "$T/router-routes-before.json"', 'python3 scripts/ops/router_routes.py snapshot "$T/router-routes-before.json" || true')),
    "M16 rollback PASS without public readbacks": ("R", lambda: sub(R, 'if [ "$version_ok$routes_ok$public_ok" != "111" ]', 'if [ "$version_ok$routes_ok" != "11" ]')),
    "M17 rollback PASS without a route snapshot": ("R", lambda: sub(R, 'echo "::error title=ROUTER_ROLLBACK_ROUTES_FAIL::', 'routes_ok=1; echo "::error title=ROUTER_ROLLBACK_ROUTES_FAIL::')),
    "M18 verify checks only the 2 publicly probed patterns": ("S", lambda: sub(S, 'bad["missing_expected"] += sum(1 for p in missing if p in expected)', 'bad["missing_expected"] += sum(1 for p in missing if p in expected[:2])')),
    "M19 verify ignores deleted routes of other scripts": ("S", lambda: sub(S, 'bad["missing_other"] += sum(1 for p in missing if p not in expected)', 'bad["missing_other"] += 0')),
    "M20 verify ignores changed route scripts": ("S", lambda: sub(S, 'bad["changed"] += len(changed)', 'bad["changed"] += 0')),
    "M21 verify ignores added routes": ("S", lambda: sub(S, 'bad["extra"] += len(extra)', 'bad["extra"] += 0')),
    "M22 restore trusts write status (no re-read)": ("S", lambda: sub(S, 'if left:\n        raise Fail(', 'if False:\n        raise Fail(')),
    "M23 restore does not delete routes the deploy added": ("S", lambda: sub(S, 'ops = [("DELETE", f"{base}/{live[p][\'id\']}", None, "deleted") for p in extra]', 'ops = []')),
    "M24 restore does not revert changed routes": ("S", lambda: sub(S, 'ops += [("PUT", f"{base}/{live[p][\'id\']}", body(p), "updated") for p in changed]\n', '')),
    "M25 zone account not checked": ("S", lambda: sub(S, 'if acct != CANONICAL_ACCOUNT:', 'if False:')),
    "M26 snapshot file account not checked": ("S", lambda: sub(S, 'snap.get("account") != CANONICAL_ACCOUNT', 'False')),
    "M27 snapshot allows conflicts and router drift": ("S", lambda: sub(S, 'if conflicts or drift:', 'if False:')),
    "M28 restore skips zone ownership re-check": ("S", lambda: sub(S, '        reverify_zone(tok, zid, z["name"])\n        target = {r["pattern"]: r["script"] for r in z["routes"]}\n        live', '        target = {r["pattern"]: r["script"] for r in z["routes"]}\n        live')),
    "M29 add-mask echoed outside Actions": ("S", lambda: sub(S, 'if GHA and value:', 'if value:')),
}


def run(env_extra, failfast=False):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
    cmd = [sys.executable, "-m", "unittest"] + (["-f"] if failfast else []) + ["tests.test_public_router_deploy"]
    return subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=900)


def one(item):
    name, (which, fn) = item
    var, fname = TARGET[which]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / fname
        f.write_text(fn())
        p = run({var: str(f)}, failfast=True)
    return name, p.returncode != 0


base = run({})
if base.returncode != 0:
    print(base.stderr[-3000:])
    print("MUTANT BASELINE FAILED (suíte sem mutação não passa)")
    sys.exit(2)
print("MUTANT BASELINE PASS", flush=True)
survivors = 0
with ThreadPoolExecutor(max_workers=max(2, os.cpu_count() or 2)) as ex:
    for name, killed in ex.map(one, M.items()):
        mid = name.split()[0]
        survivors += 0 if killed else 1
        print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} — {name[len(mid) + 1:]}", flush=True)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
