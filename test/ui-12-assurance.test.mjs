import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../public/control-plane-vnext.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/control-plane-vnext.js', import.meta.url), 'utf8');

const requiredTokens = [
  '--cp-color-bg','--cp-color-surface','--cp-color-surface-elevated','--cp-color-text',
  '--cp-color-text-muted','--cp-color-success','--cp-color-warning','--cp-color-danger',
  '--cp-color-accent','--cp-color-focus',
  '--cp-font-sans','--cp-font-mono','--cp-text-xs','--cp-text-sm','--cp-text-md',
  '--cp-text-lg','--cp-text-xl','--cp-text-2xl','--cp-text-3xl',
  '--cp-space-1','--cp-space-2','--cp-space-3','--cp-space-4','--cp-space-5','--cp-space-6','--cp-space-8',
  '--cp-radius-sm','--cp-radius-md','--cp-radius-lg','--cp-radius-xl',
  '--cp-shadow-elevated','--cp-shadow-dialog','--cp-control-min','--cp-grid-gap'
];

test('UI-12 design system exposes complete semantic token families', () => {
  for (const token of requiredTokens) assert.ok(css.includes(token + ':'), token + ' missing');
});

test('UI-12 spacing and geometry are token-driven in primary components', () => {
  for (const selector of ['.cpv2-state{','.cpv2-card{','.cpv2-proofbar{','.cpv2-policy-shell{','.cpv2-pillar{']) {
    const start=css.indexOf(selector); assert.ok(start>=0, selector+' missing');
    const block=css.slice(start,css.indexOf('}',start)+1);
    assert.match(block,/var\(--cp-(space|radius|grid|border)/);
  }
});

test('UI-12 type scale is semantic and primary surface avoids raw px font sizes', () => {
  assert.doesNotMatch(css,/font-size:\s*\d+(?:\.\d+)?px/);
  assert.match(css,/font-size:clamp\(var\(--cp-text-2xl\)/);
});

test('UI-12 defines responsive hierarchy for desktop tablet and mobile', () => {
  assert.match(css,/@media\(max-width:81\.25rem\)/);
  assert.match(css,/@media\(max-width:56\.25rem\)/);
  assert.match(css,/@media\(max-width:40rem\)/);
  assert.match(css,/\.cpv2-grid\{grid-template-columns:1fr\}/);
});

test('UI-12 defines keyboard, reduced-motion and forced-colors behavior', () => {
  assert.match(css,/:focus-visible/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/@media\(forced-colors:active\)/);
  assert.match(css,/--cp-control-min:2\.75rem/);
});

test('UI-12 preserves evidence-first fail-closed semantics', () => {
  assert.match(js,/SEM PROVA CAN/);
  assert.match(js,/fail-closed/);
  assert.match(js,/\/api\/control-plane/);
});

test('UI-12 forbids legacy visual-system regressions in vNext CSS', () => {
  assert.doesNotMatch(css,/--cp-radius:\s*18px/);
  assert.doesNotMatch(css,/font-size:\s*10\.5px/);
  assert.doesNotMatch(css,/font-size:\s*8\.5px/);
  assert.doesNotMatch(css,/padding:\s*18px 20px/);
});
