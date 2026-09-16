import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const gitlab = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
const circle = readFileSync(new URL('../.circleci/config.yml', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../docs/CI_EXECUTION_POLICY.md', import.meta.url), 'utf8');
const evidence = readFileSync(new URL('../evidence/EG-0055-GIT-PROVIDER-DIVERSITY.md', import.meta.url), 'utf8');

test('CircleCI is the canonical remote executor and GitLab is passive', () => {
  assert.match(policy, /CircleCI is the canonical remote execution plane/);
  assert.match(gitlab, /workflow:\s*\n\s*rules:\s*\n\s*- when: never/);
  for (const command of ['npm test','npm run supplychain:scan','npm audit --omit=dev --audit-level=high','npm run audit:3x','npm run audit:security:10x','npm run audit:lifecycle:10x','npm run audit:lifecycle:evidence:10x','npm run audit:closure:10x'])
    assert.match(circle, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
test('heavy CI stays on remote cloud executors only', () => {
  assert.match(circle, /cimg\/node:24\.19/);
  assert.match(circle, /playwright install --with-deps chromium/);
  assert.match(circle, /arbm_cloud_recovery/);
  assert.doesNotMatch(circle, /shell\s*runner|localhost runner|windows runner/i);
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