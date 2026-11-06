import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextNormalized } from './helpers/text.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, '.github', 'workflows');
const EXPECTED = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['actions/setup-node', '949feb2413d6458794dcd2491c4babbbce0c15c1'],
  ['actions/upload-artifact', 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'],
  ['actions/setup-python', '6d4fd22b20465ccc0f7354476588e8df7c9ca0e0'],
  ['actions/download-artifact', '37930b1c2abaa49bbe596cd826c3c89aef350131'],
  ['actions/jekyll-build-pages', '44a6e6beabd48582f863aeeb6cb2151cc1716697'],
  ['google-github-actions/auth', '7c6bc770dae815cd3e89ee6cdf493a5fab2cc093'],
  ['google-github-actions/setup-gcloud', 'aa5489c8933f4cc7a4f7d45035b3b1440c9c10db'],
]);

test('all selected first-party actions are Node 24 releases pinned by full immutable SHA', () => {
  const counts = new Map([...EXPECTED.keys()].map((name) => [name, 0]));
  const violations = [];
  for (const file of readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readTextNormalized(join(DIR, file));
    for (const [action, sha] of EXPECTED) {
      for (const match of text.matchAll(new RegExp(`${action}@([^\\s"']+)`, 'g'))) {
        counts.set(action, counts.get(action) + 1);
        if (match[1] !== sha) violations.push(`${file}: actions/${action}@${match[1]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(Object.fromEntries(counts), {
    'actions/checkout': 221,
    'actions/setup-node': 113,
    'actions/upload-artifact': 62,
    'actions/setup-python': 28,
    'actions/download-artifact': 4,
    'actions/jekyll-build-pages': 1,
    'google-github-actions/auth': 3,
    'google-github-actions/setup-gcloud': 2,
  });
});

test('Ubuntu selectors are explicit 24.04 and setup-node automatic caching is disabled', () => {
  let ubuntu = 0, setup = 0, cacheOptOut = 0;
  const latest = [];
  for (const file of readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name))) {
    const text = readTextNormalized(join(DIR, file));
    ubuntu += (text.match(/ubuntu-24\.04/g) || []).length;
    setup += (text.match(/actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/g) || []).length;
    cacheOptOut += (text.match(/package-manager-cache["']?\s*:\s*["']?false/g) || []).length;
    if (text.includes('ubuntu-latest')) latest.push(file);
  }
  assert.deepEqual(latest, []);
  assert.equal(ubuntu, 267);
  assert.equal(cacheOptOut, setup, 'every setup-node step opts out of automatic cache behavior');
});
