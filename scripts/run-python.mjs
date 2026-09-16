import { spawnSync } from 'node:child_process';

const [, , script, ...args] = process.argv;
if (!script) {
  console.error('usage: node scripts/run-python.mjs <script.py> [...args]');
  process.exit(2);
}

const preferred = process.env.PYTHON_BIN?.trim();
const candidates = [
  ...(preferred ? [preferred] : []),
  ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
];

let lastError = null;
for (const bin of [...new Set(candidates)]) {
  const result = spawnSync(bin, [script, ...args], { stdio: 'inherit', shell: false });
  if (result.error?.code === 'ENOENT') {
    lastError = result.error;
    continue;
  }
  if (result.error) {
    console.error(`python launcher failed via ${bin}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error(`no Python interpreter found (${candidates.join(', ')})`);
if (lastError) console.error(lastError.message);
process.exit(127);
