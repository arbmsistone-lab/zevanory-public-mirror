import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../evidence/EG-0055-GIT-PROVIDER-DIVERSITY.md', import.meta.url), 'utf8');

test('GitLab CI reproduces canonical fail-closed quality gates', () => {
  for (const command of [
    'npm test',
    'npm run supplychain:scan',
    'npm audit --omit=dev --audit-level=high',
    'npm run audit:3x',
    'npm run audit:security:10x',
    'npm run audit:lifecycle:10x',
    'npm run audit:lifecycle:evidence:10x',
    'npm run audit:closure:10x',
  ]) assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('GitLab CI keeps heavy work on cloud container runners', () => {
  assert.match(ci, /image: node:24-bookworm/);
  assert.match(ci, /aquasec\/trivy:0\.74\.0/);
  assert.match(ci, /mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
  assert.doesNotMatch(ci, /shell\s*runner|localhost runner|windows runner/i);
});
test('migration evidence records three independent primary sources and preserves commercial NO-GO', () => {
  assert.match(evidence, /docs\.gitlab\.com/);
  assert.match(evidence, /developers\.cloudflare\.com/);
  assert.match(evidence, /vercel\.com\/docs\/git/);
  assert.match(evidence, /No production cutover/i);
  assert.match(evidence, /Do not enable sales, checkout or financial events/i);
});

test('repository authority is provider-neutral and GitHub is not mandatory', async()=>{
  const audit=readFileSync(new URL('../scripts/audit-no-single-provider.mjs', import.meta.url),'utf8');
  assert.match(audit,/ZEVANORY_AZURE_REPO_URL/);
  assert.match(audit,/ZEVANORY_BITBUCKET_URL/);
  assert.match(audit,/non-GitHub authority available/);
  assert.match(audit,/repository quorum >=2 providers/);
  assert.doesNotMatch(audit,/code local=GitHub.*&&/);
});
