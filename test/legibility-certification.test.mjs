import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');

test('compact viewport enforces readable text floor',()=>{
  assert.match(css,/EG-0043\.3/);
  assert.match(css,/kpi-cluster span\{font-size:8px\}/);
  assert.match(css,/details-grid span\{font-size:8px\}/);
  assert.match(css,/rail-grid span\{font-size:8px\}/);
  assert.match(css,/commercial-label span,.commercial-facts span\{font-size:8px\}/);
});

test('commercial labels avoid needless wrapping pressure',()=>{
  assert.match(html,/<span>WhatsApp<\/span><b id="whatsapp">/);
  assert.match(css,/switches span\{white-space:normal;overflow:visible;text-overflow:clip/);
});

test('headline font box is protected from glyph clipping',()=>{
  assert.match(css,/decision-copy h1\{padding-bottom:3px\}/);
  assert.equal(css.includes('overflow:auto'),false);
});

test('dynamic operational values wrap instead of truncating',()=>{
  assert.match(css,/details-grid b\{white-space:normal;overflow:visible;text-overflow:clip/);
  assert.match(css,/risk-rail \.audit-grid \.assurance-summary\{margin-top:2px\}/);
});

test('tall desktop also keeps an eight pixel readable floor',()=>{
  assert.match(css,/EG-0043\.5/);
  assert.match(css,/agent-line,.release-line,.recovery-line\{font-size:8px\}/);
  assert.match(css,/commercial-label span,.commercial-facts span,.switches span\{font-size:8px\}/);
});