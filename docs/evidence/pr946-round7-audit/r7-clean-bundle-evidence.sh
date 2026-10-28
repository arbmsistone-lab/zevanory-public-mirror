#!/usr/bin/env bash
# PR #946, round 7 (M-1): real run of scripts/deploy/clean_bundle.py with the anchored lockfile and wrangler 4.143.0.
# Usage: r7-clean-bundle-evidence.sh <git repo> <commit sha> <empty scratch dir>
# Needs network access to registry.npmjs.org (npm ci). Writes nothing to the repository.
set -uo pipefail
R="$1"; SHA="$2"; S="$3"
mkdir -p "$S"; cd "$S"
git -C "$R" show "$SHA:scripts/deploy/clean_bundle.py" > "$S/clean_bundle.py"
export GITHUB_RUN_ID=4242 GITHUB_REPOSITORY=arbmsistone-lab/zevanory-public-mirror PUBLIC_OWNER_ACCOUNT_ID=1b26415802588185a86c1d4d3ebf5bdb
cb() { python3 -I "$S/clean_bundle.py" "$@"; }
step() { echo; echo "=== $*"; }
T="$S/tools"   # one tools dir, reinstalled by npm ci on every run

step "1. sales: clean build A"
cb sales --repo "$R" --rev "$SHA" --tools "$T" --work "$S/sa/clean" --out "$S/sa/out" | grep -E "PINNED|CLEAN_BUNDLE"
(cd "$S/sa/out" && sha256sum *)
step "2. sales: clean build B in a different, deeper path, --verify against A"
cb sales --repo "$R" --rev "$SHA" --tools "$T" --work "$S/x/y/sb/clean" --out "$S/x/y/sb/out" --verify "$S/sa/out" | grep -E "CLEAN_BUNDLE"
step "3. central: clean build A"
cb central --repo "$R" --rev "$SHA" --tools "$T" --work "$S/ca/clean" --out "$S/ca/out" | grep -E "PINNED|CLEAN_BUNDLE|=PASS"
(cd "$S/ca/out" && sha256sum worker.bundle.js wrangler.central-fix.jsonc MANIFEST.sha256; find public -type f | wc -l)
step "4. central: clean build B elsewhere, --verify against A"
cb central --repo "$R" --rev "$SHA" --tools "$T" --work "$S/x/cb/clean" --out "$S/x/cb/out" --verify "$S/ca/out" | grep -E "CLEAN_BUNDLE"
rm -rf "$S/x"

step "5. round-6 flow (full checkout, generators + node materialize, same pinned wrangler) gives the same bytes"
mkdir -p "$S/old" && git -C "$R" archive "$SHA" | tar -x -C "$S/old"
W="$T/node_modules/.bin/wrangler"; WENV=(env -i PATH="$PATH" HOME="$S/home" CI=1 WRANGLER_SEND_METRICS=false XDG_CONFIG_HOME="$S/xdg")
( cd "$S/old" && GITHUB_SHA="$SHA" python3 -I scripts/ci/materialize_sales_configs.py >/dev/null \
  && "${WENV[@]}" "$W" deploy --dry-run --strict --config wrangler.sales.deploy.toml --outdir "$S/old-sales" >/dev/null 2>&1 )
cmp "$S/old-sales/sales-worker.js" "$S/sa/out/sales-worker.deploy.js" && echo "SALES_ROUND6_FLOW_BUNDLE=IDENTICAL"
( cd "$S/old" && rm -rf public && git -C "$R" archive 83620c680958d726fc4b0fd16e2574cdcc362a6d public | tar -x \
  && node scripts/deploy/materialize-control-plane.mjs && cp admin.css public/admin.css \
  && TARGET_RUNTIME_SHA="$SHA" python3 scripts/deploy/write-build-info.py \
  && git -C "$R" show 83620c680958d726fc4b0fd16e2574cdcc362a6d:wrangler.jsonc > wrangler.central-fix.jsonc \
  && TARGET_RUNTIME_SHA="$SHA" python3 scripts/deploy/prepare-central-candidate.py >/dev/null \
  && python3 scripts/deploy/copy-brand-export.py >/dev/null \
  && "${WENV[@]}" "$W" deploy --dry-run --strict --keep-vars --config wrangler.central-fix.jsonc --outdir "$S/old-central" >/dev/null 2>&1 )
cmp "$S/old-central/cloudflare-worker.compat.js" "$S/ca/out/worker.bundle.js" && echo "CENTRAL_ROUND6_FLOW_BUNDLE=IDENTICAL"
diff -rq "$S/old/public" "$S/ca/out/public" && echo "CENTRAL_ROUND6_FLOW_PUBLIC=IDENTICAL"

step "6. test-time mutation of the Worker source in the build workspace -> forged artifact -> deploy-side rebuild refuses it"
printf '\nglobalThis.__injected = "INJECTED-BY-TEST";\n' >> "$S/old/worker/sales-public-worker.mjs"   # what a test could write
( cd "$S/old" && "${WENV[@]}" "$W" deploy --dry-run --strict --config wrangler.sales.deploy.toml --outdir "$S/forged-b" >/dev/null 2>&1 )
cp -a "$S/sa/out" "$S/forged" && cp "$S/forged-b/sales-worker.js" "$S/forged/sales-worker.deploy.js"
grep -c "INJECTED-BY-TEST" "$S/forged/sales-worker.deploy.js" | sed 's/^/forged bundle carries the mutation: /'
cb sales --repo "$R" --rev "$SHA" --tools "$T" --work "$S/d/clean" --out "$S/d/out" --verify "$S/forged" | grep -E "CLEAN_BUNDLE"
echo "deploy-side rebuild exit code: ${PIPESTATUS[0]}"

step "7. commit with node_modules/.bin/wrangler (stub) and .npmrc -> refused, stub never runs"
git clone -q --no-checkout "$R" "$S/evil" && git -C "$S/evil" checkout -q "$SHA" 2>/dev/null
mkdir -p "$S/evil/node_modules/.bin" && printf '#!/bin/sh\ntouch "%s/PWNED"\n' "$S" > "$S/evil/node_modules/.bin/wrangler" && chmod +x "$S/evil/node_modules/.bin/wrangler"
printf 'registry=https://evil.invalid/\n' > "$S/evil/.npmrc"
git -C "$S/evil" add -f node_modules .npmrc && git -C "$S/evil" -c user.name=e -c user.email=e@e -c commit.gpgsign=false commit -qm evil
cb sales --repo "$S/evil" --rev "$(git -C "$S/evil" rev-parse HEAD)" --tools "$T" --work "$S/e/clean" --out "$S/e/out" 2>&1 | grep -E "CLEAN_BUNDLE"
test -e "$S/PWNED" && echo "STUB_EXECUTED=YES" || echo "STUB_EXECUTED=NO"
