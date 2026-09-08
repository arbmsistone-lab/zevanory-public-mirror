import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chromium, { inflate } from '@sparticuz/chromium';

const entry = fileURLToPath(import.meta.resolve('@sparticuz/chromium'));
const packageRoot = resolve(dirname(entry), '..');
const binDir = join(packageRoot, 'bin');
const al2023Archive = join(binDir, 'al2023.tar.br');

if (!existsSync(al2023Archive)) {
  console.error(`SERVERLESS_CHROMIUM_AL2023_MISSING ${al2023Archive}`);
  process.exit(1);
}

await inflate(al2023Archive);
const libraryPath = '/tmp/al2023/lib';
const nsprPath = join(libraryPath, 'libnspr4.so');
if (!existsSync(nsprPath)) {
  console.error(`SERVERLESS_CHROMIUM_NSPR_MISSING ${nsprPath}`);
  process.exit(1);
}

const executablePath = await chromium.executablePath(binDir);
if (!executablePath) {
  console.error('SERVERLESS_CHROMIUM_PATH_MISSING');
  process.exit(1);
}

console.log(JSON.stringify({
  executablePath,
  libraryPath,
}));
