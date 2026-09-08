import { spawn, spawnSync } from 'node:child_process';

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
  console.log(`VERCEL_REMOTE_CERT_CHECK ${number}/36 ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(), env, stdio: 'inherit', shell: false,
  });
  if (result.error || result.status !== 0) {
    console.error(`VERCEL_REMOTE_CERT_BLOCKED check=${number} status=${result.status ?? 'error'}`);
    if (result.error) console.error(result.error.message);
    process.exit(1);
  }
};

console.log(`VERCEL_REMOTE_CERT_START sha=${sha} branch=${branch} checks=36`);
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

console.log('VERCEL_REMOTE_CERT_CHECK 35/36 Resolve serverless Chromium');
const chromiumResult = spawnSync(process.execPath, ['scripts/serverless-chromium-path.mjs'], {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', shell: false,
});
if (chromiumResult.error || chromiumResult.status !== 0) {
  process.stderr.write(chromiumResult.stderr || '');
  console.error('VERCEL_REMOTE_CERT_BLOCKED check=35 serverless Chromium resolution failed');
  process.exit(1);
}
let chromiumInfo;
try {
  chromiumInfo = JSON.parse(String(chromiumResult.stdout || '').trim().split(/\r?\n/).at(-1));
} catch {
  console.error('VERCEL_REMOTE_CERT_BLOCKED check=35 invalid Chromium metadata');
  process.exit(1);
}
const chromiumPath = String(chromiumInfo?.executablePath || '');
const chromiumLibraryPath = String(chromiumInfo?.libraryPath || '');
if (!chromiumPath || !chromiumLibraryPath) {
  console.error('VERCEL_REMOTE_CERT_BLOCKED check=35 incomplete Chromium metadata');
  process.exit(1);
}

const ffmpeg = spawnSync('npx', ['playwright', 'install', 'ffmpeg'], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false,
});
if (ffmpeg.error || ffmpeg.status !== 0) {
  console.error(`VERCEL_REMOTE_CERT_BLOCKED check=35 ffmpeg status=${ffmpeg.status ?? 'error'}`);
  process.exit(1);
}

const server = spawn(npm, ['start'], {
  cwd: process.cwd(),
  env: { ...process.env, HOST: '127.0.0.1', PORT: '4173' },
  stdio: ['ignore', 'inherit', 'inherit'],
  shell: false,
});
let live = false;
let e2eStatus = 1;
try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const response = await fetch('http://127.0.0.1:4173/api/live');
      if (response.ok) { live = true; break; }
    } catch {}
  }
  if (!live) {
    console.error('VERCEL_REMOTE_CERT_BLOCKED check=36 local E2E server did not become live');
  } else {
    console.log('VERCEL_REMOTE_CERT_CHECK 36/36 Playwright E2E desktop-1366 + desktop-1920');
    const e2e = spawnSync(npm, ['run', 'test:e2e'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZEVANORY_BASE_URL: 'http://127.0.0.1:4173',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chromiumPath,
        LD_LIBRARY_PATH: `${chromiumLibraryPath}:${process.env.LD_LIBRARY_PATH || ''}`,
      },
      stdio: 'inherit',
      shell: false,
    });
    e2eStatus = e2e.error ? 1 : (e2e.status ?? 1);
  }
} finally {
  server.kill('SIGTERM');
}
if (!live || e2eStatus !== 0) {
  console.error(`VERCEL_REMOTE_CERT_BLOCKED check=36 status=${e2eStatus}`);
  process.exit(1);
}
console.log(`VERCEL_REMOTE_CERT_APPROVED sha=${sha} checks=36/36`);
