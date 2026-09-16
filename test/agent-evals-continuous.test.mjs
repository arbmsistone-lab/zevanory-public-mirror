import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAgentDecision} from '../src/agentEvals.mjs';

const base={rationale:'evidence-based decision',confidence:.8};
const evalOne=(decision,context={},authorization=null,tool=null)=>evaluateAgentDecision({decision:{...base,...decision},context,authorization,tool});

test('tool selection mismatch is blocked',()=>{
  const r=evalOne({action:'offer'}, {}, null, 'send_message');
  assert.equal(r.pass,false);assert.ok(r.issues.includes('tool_selection_mismatch'));
});

test('message requires content and recipient',()=>{
  const r=evalOne({action:'send_message'},{lead:{contact_ref:null}},null,'send_message');
  assert.deepEqual([...r.issues].sort(),['customer_message_confidence_below_99pct','message_content_missing','message_recipient_missing'].sort());
});

test('Instagram publishing requires HTTPS media',()=>{
  const r=evalOne({action:'publish_content',channel:'instagram',content:'Post'},{},null,'publish_content');
  assert.equal(r.pass,false);assert.ok(r.issues.includes('instagram_media_missing'));
});

test('valid Instagram decision passes trajectory gate',()=>{
  const r=evalOne({action:'publish_content',channel:'instagram',content:'Post',media_url:'https://cdn.example.com/a.jpg'},{},null,'publish_content');
  assert.equal(r.pass,true);assert.equal(r.expected_tool,'publish_content');
});

test('YouTube publishing requires HTTPS media and title',()=>{
  const missing=evalOne({action:'publish_content',channel:'youtube',content:'Demo',title:'Demo'},{},null,'publish_content');
  assert.equal(missing.pass,false);assert.ok(missing.issues.includes('youtube_media_missing'));
  const valid=evalOne({action:'publish_content',channel:'youtube',content:'Demo',title:'Demo',media_url:'https://cdn.example.com/v.mp4'},{},null,'publish_content');
  assert.equal(valid.pass,true);
});
