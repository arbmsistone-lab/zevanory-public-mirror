import { spawnSync } from 'node:child_process';

const TARGET_BRANCH = 'feat/live-action-plan';
const deployEnv = String(process.env.VERCEL_ENV || '');
const branch = String(process.env.VERCEL_GIT_COMMIT_REF || '');
const sha = String(process.env.VERCEL_GIT_COMMIT_SHA || '');

if (deployEnv !== 'preview' || branch !== TARGET_BRANCH) {
  console.log(`VERCEL_REMOTE_CERT_SKIPPED env=${deployEnv || 'unknown'} branch=${branch || 'unknown'}`);
  process.exit(0);
}

if (!sha) {
  console.error('VERCEL_REMOTE_CERT_BLOCKED missing VERCEL_GIT_COMMIT_SHA');
  process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  [npm, ['test']],
  [npm, ['run', 'supplychain:scan']],
  [npm, ['audit', '--omit=dev', '--audit-level=high']],
  [npm, ['run', 'contract:smoke']],
  [npm, ['run', 'audit:enterprise:10x']],
  [npm, ['run', 'audit:activation:20x']],
  [npm, ['run', 'audit:offer:20x']],
  [npm, ['run', 'audit:channels:20x']],
  [npm, ['run', 'audit:social-channels:20x']],
  [npm, ['run', 'audit:channel-identity:20x']],
  [npm, ['run', 'audit:distribution:10x']],
  [npm, ['run', 'audit:pilot:10x']],
  [npm, ['run', 'audit:rules:20x']],
  [npm, ['run', 'audit:engine:20x']],
  [npm, ['run', 'audit:command:20x']],
  [npm, ['run', 'audit:worldclass:10x']],
  [npm, ['run', 'audit:composable:10x']],
  [npm, ['run', 'audit:architecture:20x']],
  [npm, ['run', 'audit:3x']],
  [npm, ['run', 'audit:obs:10x']],
  [npm, ['run', 'audit:live-plan:3x']],
  [npm, ['run', 'audit:10x']],
  [npm, ['run', 'resilience:smoke']],
  [npm, ['run', 'audit:30x']],
  [npm, ['run', 'audit:sales:20x']],
  [npm, ['run', 'audit:final']],
  [npm, ['run', 'audit:lifecycle:10x']],
  [npm, ['run', 'audit:lifecycle:evidence:10x']],
  [npm, ['run', 'audit:closure:10x']],
  [npm, ['run', 'audit:final20x']],
  [npm, ['run', 'security:lifecycle']],
  [npm, ['run', 'audit:security:10x']],
  [process.execPath, ['--test', 'test/adaptive-rate-limit.test.mjs', 'test/secret-lifecycle.test.mjs']],
];

const runSyncGate = (number, label, command, args, env = process.env) => {
  console.log(`VERCEL_REMOTE_CERT_CHECK ${number}/34 ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(), env, stdio: 'inherit', shell: false,
  });
  if (result.error || result.status !== 0) {
    console.error(`VERCEL_REMOTE_CERT_BLOCKED check=${number} status=${result.status ?? 'error'}`);
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
};

console.log(`VERCEL_REMOTE_CERT_START sha=${sha} branch=${branch} checks=34`);
for (let index = 0; index < checks.length; index += 1) {
  const [command, args] = checks[index];
  runSyncGate(index + 1, `${command} ${args.join(' ')}`, command, args);
}

if (process.platform !== 'linux') {
  console.error('VERCEL_REMOTE_CERT_BLOCKED heavy gates require Linux preview builder');
  process.exit(1);
}

const trivyScript = `set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSLO https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-64bit.tar.gz
echo "2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a  trivy_0.74.0_Linux-64bit.tar.gz" | sha256sum -c -
tar -xzf trivy_0.74.0_Linux-64bit.tar.gz trivy
./trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --exit-code 1 --skip-dirs node_modules "$ZEVANORY_SCAN_ROOT"`;
runSyncGate(34, 'Trivy HIGH/CRITICAL filesystem gate', 'bash', ['-lc', trivyScript], {
  ...process.env, ZEVANORY_SCAN_ROOT: process.cwd(),
});

console.log('VERCEL_REMOTE_CERT_E2E_DELEGATED provider=containerized-playwright reason=vercel-builder-has-no-apt-get');
console.log(`VERCEL_REMOTE_CERT_APPROVED sha=${sha} checks=34/34`);
