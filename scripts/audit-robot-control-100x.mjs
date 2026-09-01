import {readFile,writeFile,access} from 'node:fs/promises';
const text=async p=>readFile(p,'utf8'); const exists=async p=>{try{await access(p);return true}catch{return false}};
const [worker,policy,revenue,outbox,assurance,api,html,js,m8,m9,m11,config,channels]=await Promise.all([
  text('src/agentWorker.mjs'),text('src/agentPolicy.mjs'),text('src/revenueAgent.mjs'),text('src/integrationOutbox.mjs'),text('src/enterpriseAssurance.mjs'),text('api/robot-control.mjs'),text('public/zevanory-robot-control.html'),text('public/zevanory-robot-control.js'),text('db/migrations/008_autonomous_revenue_engine.sql'),text('db/migrations/009_composable_infrastructure.sql'),text('db/migrations/011_agent_control_and_trace.sql'),text('src/config.mjs'),text('src/channelAdapters.mjs')]);
const checks=[]; const add=(domain,label,ok,severity='P2')=>checks.push({id:String(checks.length+1).padStart(3,'0'),domain,label,ok:Boolean(ok),severity});
const has=(s,x)=>s.includes(x); const rx=(s,r)=>r.test(s);

// 01-10 Governance / truth
add('governance','global sale gate exists',has(policy,'SALE_GLOBALLY_ENABLED'));
add('governance','pre-sale gate exists',has(policy,'PRE_SALE_GATES_APPROVED'));
add('governance','financial gate exists',has(policy,'FINANCIAL_EVENTS_ENABLED'));
add('governance','checkout gate exists',has(policy,'CHECKOUT_ENABLED'));
add('governance','deny by default exists',has(policy,'deny_by_default'));
add('governance','unsupported claims eval exists',await exists('src/agentEvals.mjs'));
add('governance','public control room noindex',has(html,'noindex,nofollow,noarchive'));
add('governance','demo explicitly labeled',has(html,'MODO DEMONSTRAÇÃO'));
add('governance','no invented activity statement',has(html,'SEM PII · SEM ATIVIDADE INVENTADA'));
add('governance','operator mode explicitly labeled',has(js,'MODO OPERADOR AUTENTICADO'));

// 11-20 Runtime integrity
add('runtime','job claiming uses skip locked',has(worker,'skip locked'));
add('runtime','run id is unique UUID',has(worker,'const runId=randomUUID()'));
add('runtime','agent run persisted',has(worker,'insert into agent_runs'));
add('runtime','tool audit persisted',has(worker,'insert into agent_tool_audit'));
add('runtime','run inserted before tool audit',worker.lastIndexOf('insert into agent_runs')<worker.lastIndexOf('await auditTool'),'P0');
add('runtime','tool execution failure recorded',has(worker,"outcome='failed'"));
add('runtime','job failure captures error',has(worker,"last_error=$3"));
add('runtime','AI fallback exists',has(worker,"AGENT_AI_ENABLED!=='true'"));
add('runtime','AI hourly cap exists',has(worker,'AGENT_AI_MAX_RUNS_PER_HOUR'));
add('runtime','worker integrity regression test exists',await exists('test/agent-worker-integrity.test.mjs'));

// 21-30 Tool safety
add('tools','read tools classified',has(policy,"get_command_center: 'read'"));
add('tools','write tools classified',has(policy,"schedule_follow_up: 'write'"));
add('tools','commercial tools classified',has(policy,"publish_content: 'commercial'"));
add('tools','financial tools classified',has(policy,"start_checkout: 'financial'"));
add('tools','send message policy exists',has(policy,'send_message'));
add('tools','publish content policy exists',has(policy,'publish_content'));
add('tools','refund policy exists',has(policy,'refund_payment'));
add('tools','commercial tool requires gates',has(policy,"reason:commercial?'commercial_gates_open':'commercial_gates_closed'"));
add('tools','financial tool requires gates',has(policy,"reason:financial?'financial_gates_open':'financial_gates_closed'"));
add('tools','tool audit stores authorization reason',has(m8,'reason text NOT NULL'));

// 31-40 End-to-end traceability
add('traceability','job id links run to job',has(m8,'job_id uuid REFERENCES agent_jobs'));
add('traceability','tool audit links run',has(m8,'run_id uuid REFERENCES agent_runs'));
add('traceability','run stores provider',has(m8,'provider text NOT NULL'));
add('traceability','run stores model',has(m8,'model text NOT NULL'));
add('traceability','run stores mode',has(m8,"mode text NOT NULL CHECK"));
add('traceability','run stores latency',has(m8,'latency_ms integer NOT NULL'));
add('traceability','run stores decision',has(m8,"decision jsonb NOT NULL"));
add('traceability','global correlation id across lifecycle',rx(m8+m9+m11,/correlation_id|trace_id/i),'P1');
add('traceability','span id per discrete operation',rx(m8+m9+m11,/span_id/i),'P1');
add('traceability','job-run-trace hierarchy stored',has(m8,'job_id uuid REFERENCES agent_jobs')&&has(m11,'trace_id uuid')&&has(m11,'run_id uuid REFERENCES agent_runs'),'P1');

// 41-50 Commercial reachability
add('commercial','first response reaches safe tool',has(revenue,"first_response:'schedule_follow_up'"));
add('commercial','qualification reaches memory tool',has(revenue,"qualify:'remember_fact'"));
add('commercial','offer reaches draft tool',has(revenue,"offer:'create_offer_draft'"));
add('commercial','follow-up reaches scheduler',has(revenue,"follow_up:'schedule_follow_up'"));
add('commercial','send_message reachable from chooseTool',has(revenue,"send_message'"),'P0');
add('commercial','publish_content reachable from chooseTool',has(revenue,"publish_content'"),'P0');
add('commercial','start_checkout reachable from chooseTool',has(revenue,"start_checkout'"),'P0');
add('commercial','refund_payment reachable from chooseTool',has(revenue,"refund_payment'"),'P0');
add('commercial','commercial executor implemented',rx(worker,/tool==='(?:send_message|publish_content)'/),'P0');
add('commercial','financial executor implemented',rx(worker,/tool==='(?:start_checkout|refund_payment)'/),'P0');

// 51-60 Channels / delivery
add('channels','owned web modeled',has(channels,'zevanory'));
add('channels','whatsapp modeled',has(channels,'whatsapp'));
add('channels','email modeled',has(channels,'email'));
add('channels','instagram modeled',has(channels,'instagram'));
add('channels','facebook modeled',has(channels,'facebook'));
add('channels','tiktok modeled',has(channels,'tiktok'));
add('channels','youtube modeled',has(channels,'youtube'));
add('channels','linkedin modeled',has(channels,'linkedin'));
add('channels','channel readiness fail closed',has(channels,'channel_not_configured'));
add('channels','external delivery confirmation linked to agent run',rx(outbox+m9,/run_id|trace_id|correlation_id/i),'P1');

// 61-70 Resilience / outbox
add('resilience','transactional outbox exists',has(m9,'CREATE TABLE IF NOT EXISTS integration_outbox'));
add('resilience','idempotency key unique',has(m9,'idempotency_key text NOT NULL UNIQUE'));
add('resilience','outbox skip locked',has(outbox,'skip locked'));
add('resilience','bounded retry exists',has(outbox,'Math.min(3600000'));
add('resilience','dead letter exists',has(outbox,'dead_letter'));
add('resilience','adapter missing fails closed',has(outbox,"adapter_missing"));
add('resilience','delivered timestamp stored',has(m9,'delivered_at timestamptz'));
add('resilience','last error stored',has(m9,'last_error text'));
add('resilience','outbox health objective exists',has(assurance,'outbox_oldest_pending_seconds'));
add('resilience','financial compensation path is gated and queued',has(revenue,"refund:'refund_payment'")&&has(worker,"eventType:'refund_payment'")&&has(worker,"destination:'payment:refund'"),'P1');

// 71-80 Security / privacy
add('security','operator API uses bearer timing-safe auth',has(api,'safeBearerEqual'));
add('security','operator API requires OPERATOR_TOKEN',has(api,'OPERATOR_TOKEN'));
add('security','control API constrains GET and POST',has(api,"['GET','POST'].includes(req.method)"));
add('security','control API no-store',has(api,"cache-control','no-store"));
add('security','control API nosniff',has(api,"x-content-type-options','nosniff"));
add('security','control query omits session_id',!rx(api,/select[^`]*session_id/i));
add('security','control query omits lead_id',!rx(api,/select[^`]*lead_id/i));
add('security','control query omits outbox payload',!rx(api,/select[^`]*payload/i));
add('security','errors are length capped',has(api,'slice(0,240)'));
add('security','model context is PII-minimized by allowlist',has(revenue,'job_type:context.job_type')&&has(revenue,'stage:context.lead?.stage')&&has(revenue,'channel:context.lead?.channel')&&has(revenue,'touchpoints:context.lead?.touchpoints')&&!/input\s*=\s*\{[^}]*contact_ref/s.test(revenue)&&!/input\s*=\s*\{[^}]*session_id/s.test(revenue),'P1');

// 81-90 Control room UX / human oversight
add('control-room','timeline exists',has(html,'LINHA DO TEMPO'));
add('control-room','capability matrix exists',has(html,'CAPACIDADES'));
add('control-room','gates panel exists',has(html,'GOVERNANÇA'));
add('control-room','journey view exists',has(html,'FUNIL OPERACIONAL'));
add('control-room','health panel exists',has(html,'Erros, retries e outbox'));
add('control-room','blocked differs from completed',has(js,"stateClass"));
add('control-room','live operator polling exists',has(js,'setInterval')&&has(js,'/api/robot-control'));
add('control-room','operator token not persisted',!rx(js,/localStorage|sessionStorage|document\.cookie/));
add('control-room','human stop/pause command exists',has(api,'setAgentPaused')&&has(js,'command:action'),'P0');
add('control-room','high-risk approval queue exists',rx(m8+m11,/approval|human_review|pending_approval/i),'P0');

// 91-100 SRE / quality / economics
add('quality','agent failed-run objective exists',has(assurance,'agent_failed_runs_ratio_max'));
add('quality','p95 latency objective exists',has(assurance,'p95_latency_ms'));
add('quality','p99 latency objective exists',has(assurance,'p99_latency_ms'));
add('quality','availability objective exists',has(assurance,'availability_ratio'));
add('quality','error ratio objective exists',has(assurance,'error_ratio_max'));
add('quality','agent run token usage stored',rx(m8+m11,/input_tokens|output_tokens|token_usage/i),'P2');
add('quality','agent run cost stored',rx(m8+m11,/cost|spend|price/i),'P2');
add('quality','continuous eval result stored',has(m8,'decision jsonb')&&has(worker,'eval:evalResult'));
add('quality','robot control regression test exists',await exists('test/robot-control.test.mjs'));
add('quality','world-class evidence gate exists',await exists('evidence/EG-0052-robot-observability-worldclass.md'));

if(checks.length!==100) throw new Error(`audit_check_count_${checks.length}`);
const failed=checks.filter(x=>!x.ok),passed=checks.length-failed.length;
const critical=failed.filter(x=>x.severity==='P0').length;
const result={timestamp:new Date().toISOString(),audit:'ZEVANORY_ROBOT_CONTROL_100X',total:100,passed,failed:failed.length,critical,status:failed.length?'BLOCKED':'APPROVED',checks};
await writeFile('validation/ROBOT-CONTROL-100X-CURRENT.json',JSON.stringify(result,null,2)+'\n','utf8');
for(const c of checks) console.log(`${c.ok?'PASS':'FAIL'} ${c.id} ${c.severity} ${c.domain} :: ${c.label}`);
console.log(`ROBOT_CONTROL_100X_${result.status} total=100 passed=${passed} failed=${failed.length} critical=${critical}`);
process.exitCode=failed.length?2:0;
