import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ci = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../evidence/EG-0055-GIT-PROVIDER-DIVERSITY.md', import.meta.url), 'utf8');

test('GitLab CI reproduces canonical fail-closed quality gates', () => {
  for (const command of ['npm test','npm run supplychain:scan','npm audit --omit=dev --audit-level=high','npm run audit:3x','npm run audit:security:10x','npm run audit:lifecycle:10x','npm run audit:lifecycle:evidence:10x','npm run audit:closure:10x'])
    assert.match(ci, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('GitLab CI keeps heavy work on cloud container runners', () => {
  assert.match(ci, /image: node:24-bookworm/);
  assert.match(ci, /aquasec\/trivy:0\.74\.0/);
  assert.match(ci, /mcr\.microsoft\.com\/playwright:v1\.62\.1-noble/);
  assert.doesNotMatch(ci, /shell\s*runner|localhost runner|windows runner/i);
});
test('migration evidence preserves commercial NO-GO', () => {
  assert.match(evidence, /docs\.gitlab\.com/);
  assert.match(evidence, /No production cutover/i);
  assert.match(evidence, /Do not enable sales, checkout or financial events/i);
});test('repository authority requires two non-GitHub providers without Azure',()=>{
  const audit=readFileSync(new URL('../scripts/audit-no-single-provider.mjs', import.meta.url),'utf8');
  const gitee=readFileSync(new URL('../gitee-mirror.md', import.meta.url),'utf8');
  assert.match(audit,/ZEVANORY_GITEE_REPO_URL/);
  assert.match(audit,/ZEVANORY_BITBUCKET_URL/);
  assert.match(audit,/non-GitHub quorum >=2 providers/);
  assert.match(audit,/nonGithub\.length>=2/);
  assert.doesNotMatch(audit,/AZURE|azure/);
  assert.match(gitee,/private/);
});