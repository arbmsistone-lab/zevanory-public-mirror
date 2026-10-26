import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.github', 'workflows');
const EXPECTED = new Map([
  ['checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['setup-node', '949feb2413d6458794dcd2491c4babbbce0c15c1'],
  ['upload-artifact', 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'],
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

test('Ubuntu selectors are explicit 24.04 and setup-node automatic caching is disabled', () => {
  let ubuntu = 0, setup = 0, cacheOptOut = 0;
  const latest = [];
  for (const file of readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readFileSync(join(DIR, file), 'utf8');
    ubuntu += (text.match(/ubuntu-24\.04/g) || []).length;
    setup += (text.match(/actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/g) || []).length;
    cacheOptOut += (text.match(/package-manager-cache["']?\s*:\s*["']?false/g) || []).length;
    if (text.includes('ubuntu-latest')) latest.push(file);
  }
  assert.deepEqual(latest, []);
  assert.equal(ubuntu, 267);
  assert.equal(cacheOptOut, setup, 'every setup-node step opts out of automatic cache behavior');
});
