import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.github', 'workflows');
const EXPECTED = new Map([
  ['checkout', '08c6903cd8c0fde910a37f88322edcfb5dd907a8'],
  ['setup-node', 'a0853c24544627f65ddf259abe73b1d18a591444'],
  ['upload-artifact', '330a01c490aca151604b8cf639adc76d48f6c5d4'],
]);

test('all selected first-party actions are Node 24 releases pinned by full immutable SHA', () => {
  const counts = new Map([...EXPECTED.keys()].map((name) => [name, 0]));
  const violations = [];
  for (const file of readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(DIR, file), 'utf8');
    for (const [action, sha] of EXPECTED) {
      for (const match of text.matchAll(new RegExp(`actions/${action}@([^\\s"']+)`, 'g'))) {
        counts.set(action, counts.get(action) + 1);
        if (match[1] !== sha) violations.push(`${file}: actions/${action}@${match[1]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(Object.fromEntries(counts), { checkout: 221, 'setup-node': 113, 'upload-artifact': 62 });
});

test('Ubuntu selectors are explicit 24.04 and setup-node v5 automatic caching is disabled', () => {
  let ubuntu = 0, setup = 0, cacheOptOut = 0;
  const latest = [];
  for (const file of readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(DIR, file), 'utf8');
    ubuntu += (text.match(/ubuntu-24\.04/g) || []).length;
    setup += (text.match(/actions\/setup-node@a0853c24544627f65ddf259abe73b1d18a591444/g) || []).length;
    cacheOptOut += (text.match(/package-manager-cache["']?\s*:\s*["']?false/g) || []).length;
    if (text.includes('ubuntu-latest')) latest.push(file);
  }
  assert.deepEqual(latest, []);
  assert.equal(ubuntu, 267);
  assert.equal(cacheOptOut, setup, 'every setup-node v5 step opts out of its new automatic cache behavior');
});
