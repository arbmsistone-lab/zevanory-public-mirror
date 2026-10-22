#!/usr/bin/env python3
"""Mutantes B02 (PR #866): cada mutante altera uma CÓPIA temporária do workflow, roda
tests/test_public_router_deploy.py contra ela (ROUTER_WORKFLOW / DISCOVERY_WORKFLOW) e o original nunca é
modificado. Imprime uma linha `MUTANT <id> KILLED|SURVIVED` por mutante e sai != 0 se algum sobreviver ou se a
suíte sem mutação não passar. Uso: python3 scripts/ci/mutants_public_router.py [raiz-do-repo]
"""
import os, re, subprocess, sys, tempfile
from pathlib import Path

REPO = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
R = (REPO / ".github/workflows/public-router-deploy.yml").read_text()
D = (REPO / ".github/workflows/zpc-cloudflare-route-discovery.yml").read_text()


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
}


def run(env_extra):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", **env_extra}
    return subprocess.run([sys.executable, "-m", "unittest", "tests.test_public_router_deploy"], cwd=REPO, env=env,
                          capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=600)


base = run({})
if base.returncode != 0:
    print(base.stderr[-3000:])
    print("MUTANT BASELINE FAILED (suíte sem mutação não passa)")
    sys.exit(2)
print("MUTANT BASELINE PASS")
survivors = 0
for name, (which, fn) in M.items():
    mid = name.split()[0]
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "wf.yml"
        f.write_text(fn())
        p = run({("ROUTER_WORKFLOW" if which == "R" else "DISCOVERY_WORKFLOW"): str(f)})
    killed = p.returncode != 0
    survivors += 0 if killed else 1
    print(f"MUTANT {mid} {'KILLED' if killed else 'SURVIVED'} — {name[len(mid) + 1:]}", flush=True)
print(f"MUTANTS_TOTAL={len(M)} KILLED={len(M) - survivors} SURVIVED={survivors}")
sys.exit(1 if survivors else 0)
