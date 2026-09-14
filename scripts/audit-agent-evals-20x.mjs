import {evaluateAgentDecision} from '../src/agentEvals.mjs';
const base={rationale:'evidence-based',confidence:.8};
const run=(decision,context={},authorization=null,tool=null)=>evaluateAgentDecision({decision:{...base,...decision},context,authorization,tool});
const cases=[
  ['01 valid review',()=>run({action:'review'}, {}, null, 'get_command_center').pass],
  ['02 missing action',()=>run({action:''}).issues.includes('missing_action')],
  ['03 missing rationale',()=>evaluateAgentDecision({decision:{action:'review',confidence:.8}}).issues.includes('missing_rationale')],
  ['04 missing confidence',()=>evaluateAgentDecision({decision:{action:'review',rationale:'x'}}).issues.includes('invalid_confidence')],
  ['05 invalid confidence',()=>run({action:'review',confidence:2}).issues.includes('invalid_confidence')],
  ['06 unsupported payment claim',()=>run({action:'offer',rationale:'Pagamento confirmado'}).issues.includes('unsupported_commercial_claim')],
  ['07 guaranteed sale claim',()=>run({action:'offer',rationale:'Venda garantida amanhÃ£'}).issues.includes('unsupported_commercial_claim')],
  ['08 ROAS claim',()=>run({action:'offer',rationale:'ROAS de 5'}).issues.includes('unsupported_commercial_claim')],
  ['09 terminal stage',()=>run({action:'offer'},{lead:{stage:'paid'}}).issues.includes('terminal_stage_action')],
  ['10 blocked execution',()=>run({action:'review',execute:true},{},{allowed:false}).issues.includes('blocked_tool_requested_execution')],
  ['11 tool mismatch',()=>run({action:'offer'},{},null,'send_message').issues.includes('tool_selection_mismatch')],
  ['12 message content',()=>run({action:'send_message'},{lead:{contact_ref:'x'}},null,'send_message').issues.includes('message_content_missing')],
  ['13 message recipient',()=>run({action:'send_message',message:'oi'},{lead:{}},null,'send_message').issues.includes('message_recipient_missing')],
  ['14 valid message',()=>run({action:'send_message',message:'oi',confidence:.99},{lead:{contact_ref:'x'}},null,'send_message').pass],
  ['15 publish content',()=>run({action:'publish_content',channel:'facebook'},{},null,'publish_content').issues.includes('publish_content_missing')],
  ['16 publish channel',()=>run({action:'publish_content',content:'x'},{},null,'publish_content').issues.includes('publish_channel_missing')],
  ['17 instagram media',()=>run({action:'publish_content',channel:'instagram',content:'x'},{},null,'publish_content').issues.includes('instagram_media_missing')],
  ['18 valid instagram',()=>run({action:'publish_content',channel:'instagram',content:'x',media_url:'https://cdn.example/x.jpg'},{},null,'publish_content').pass],
  ['19 checkout session',()=>run({action:'start_checkout'},{lead:{}},null,'start_checkout').issues.includes('checkout_session_missing')],
  ['20 refund order',()=>run({action:'refund_payment'},{},null,'refund_payment').issues.includes('refund_order_missing')],
];
let failed=0;for(const [name,check] of cases){let ok=false;try{ok=Boolean(check());}catch{}console.log(`${ok?'APPROVED':'FAILED'} ${name}`);if(!ok)failed++;}
console.log(`AUDIT_AGENT_EVALS_20X_${failed?'BLOCKED':'APPROVED'} units=${cases.length} approved=${cases.length-failed} failed=${failed}`);if(failed)process.exit(1);

