import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const css=await readFile(new URL('../public/index.css',import.meta.url),'utf8');
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');

test('EG0046 is the canonical progressive executive system',()=>{
  assert.match(css,/EG-0046 — progressive executive disclosure/);
  assert.match(html,/id="details-dialog"/);
});

test('compact desktop keeps an eleven pixel primary floor',()=>{
  assert.match(css,/kpi-cluster span,.gate-card span,.mode-card span\{font-size:11px/);
  assert.match(css,/@media\(max-height:760px\)/);
});

test('tall desktop promotes primary labels to twelve pixels',()=>{
  assert.match(css,/@media\(min-height:761px\)/);
  assert.match(css,/priority-callout span,.priority-callout p\{font-size:12px\}/);
});

test('primary values wrap while live telemetry may truncate and detail scroll is explicit',()=>{
  for(const selector of ['.business-highlights b','.signal-grid small','.switches span']){
    const block=css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}'))?.[1]||'';
    assert.doesNotMatch(block,/text-overflow:ellipsis/);
  }
  assert.match(css,/\.dialog-shell\{[^}]*overflow:auto/);
  assert.match(css,/html,body\{[^}]*overflow:hidden/);
});