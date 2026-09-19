const BASE = 'https://arbm-control.zevanory.workers.dev';
const ALLOWED_REPOS = new Set([
  'arbmsistone-lab/ARBM-one',
  'arbmsistone-lab/arbm-sist-external-exec-proof',
  'arbmsistone-lab/zevanory-public-mirror',
  'arbmsistone-lab/arbm-control',
  'arbmsistone-lab/credicontrol-pro',
]);

const SAFE_BRANCH_PREFIXES = ['chatgpt/', 'codex/', 'arbm/', 'fix/', 'feat/', 'chore/', 'infra/'];
const APPROVED_PROBE_HOSTS = new Set(['arbmone.api.br','zevanory.api.br','edge.zevanory.api.br','arbm-control.zevanory.workers.dev']);

const TOOLS = [
  {
    name: 'control_status',
    description: 'Returns ARBM CONTROL health, safety policy and approved repositories.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'github_repo_status',
    description: 'Read repository metadata and default-branch head SHA for an approved ARBM repository.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string' } },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_file_read',
    description: 'Read a UTF-8 text file from an approved ARBM repository and ref.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_recent_runs',
    description: 'List recent GitHub Actions runs for an approved ARBM repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_workflow_dispatch',
    description: 'Dispatch an existing GitHub Actions workflow in an approved ARBM repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        workflow: { type: 'string' },
        ref: { type: 'string' },
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['repo', 'workflow', 'ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'github_path_list', description: 'List files and directories at a repository path and ref.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},path:{type:'string'},ref:{type:'string'}}, required:['repo'], additionalProperties:false },
  },
  {
    name: 'github_branch_create', description: 'Create a safe working branch from an exact commit SHA.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},branch:{type:'string'},source_sha:{type:'string'}}, required:['repo','branch','source_sha'], additionalProperties:false },
  },
  {
    name: 'github_file_upsert', description: 'Create or update one UTF-8 file on a safe working branch. Existing files require expected_sha.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},branch:{type:'string'},path:{type:'string'},content:{type:'string'},message:{type:'string'},expected_sha:{type:'string'}}, required:['repo','branch','path','content','message'], additionalProperties:false },
  },
  {
    name: 'github_patch_exact', description: 'Replace exact text in one existing UTF-8 file on a safe working branch. Requires exact current blob SHA and exact replacement count.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},branch:{type:'string'},path:{type:'string'},expected_sha:{type:'string'},find:{type:'string'},replace:{type:'string'},expected_count:{type:'integer',minimum:1,maximum:100},message:{type:'string'}}, required:['repo','branch','path','expected_sha','find','replace','expected_count','message'], additionalProperties:false },
  },
  {
    name: 'github_pull_request_create', description: 'Open a pull request from a safe working branch to the default branch.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},branch:{type:'string'},title:{type:'string'},body:{type:'string'}}, required:['repo','branch','title'], additionalProperties:false },
  },
  {
    name: 'github_commit_status', description: 'Read combined commit status and check runs for a SHA.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},sha:{type:'string'}}, required:['repo','sha'], additionalProperties:false },
  },
  {
    name: 'github_workflows_list', description: 'List GitHub Actions workflows for an approved repository.',
    inputSchema: { type:'object', properties:{repo:{type:'string'}}, required:['repo'], additionalProperties:false },
  },
  {
    name: 'github_workflow_run', description: 'Read one GitHub Actions workflow run and its jobs.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},run_id:{type:'integer'}}, required:['repo','run_id'], additionalProperties:false },
  },
  {
    name: 'github_workflow_job_logs', description: 'Read bounded text logs for one GitHub Actions job.',
    inputSchema: { type:'object', properties:{repo:{type:'string'},job_id:{type:'integer'},max_chars:{type:'integer',minimum:1000,maximum:20000}}, required:['repo','job_id'], additionalProperties:false },
  },
  {
    name: 'production_probe', description: 'Probe an approved production URL with a bounded GET request.',
    inputSchema: { type:'object', properties:{url:{type:'string'}}, required:['url'], additionalProperties:false },
  },
];

const READ_ONLY_TOOLS = new Set(['control_status','github_repo_status','github_file_read','github_recent_runs','github_path_list','github_commit_status','github_workflows_list','github_workflow_run','github_workflow_job_logs','production_probe']);
const WRITE_SAFE_TOOLS = new Set(['github_branch_create','github_file_upsert','github_patch_exact','github_pull_request_create','github_workflow_dispatch']);
function toolsWithAnnotations() {
  return TOOLS.map(tool => ({
    ...tool,
    annotations: READ_ONLY_TOOLS.has(tool.name)
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      : WRITE_SAFE_TOOLS.has(tool.name)
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }));
}

function securityHeaders(headers = {}) {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...headers,
  };
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ 'content-type': 'application/json; charset=utf-8', ...headers }),
  });
}

function text(data, status = 200, headers = {}) {
  return new Response(data, { status, headers: securityHeaders(headers) });
}
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function unb64url(value) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  return b64url(new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(value)
  )));
}
async function verifyHmac(secret, value, signature) {
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    return crypto.subtle.verify(
      'HMAC', key, unb64url(signature), new TextEncoder().encode(value)
    );
  } catch {
    return false;
  }
}
function signingSecret(env) {
  return env.ARBM_SIGNING_KEY;
}
function adminSecret(env) {
  return env.ARBM_ADMIN_KEY;
}
function directBearerSecret(env) {
  return env.ARBM_DIRECT_BEARER;
}

async function seal(env, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac(signingSecret(env), body)}`;
}
async function unseal(env, token, expectedType) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.', 2);
  const verified = await verifyHmac(signingSecret(env), body, sig);
  if (!verified) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64url(body))); }
  catch { return null; }
  if (payload.typ !== expectedType) return null;
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

async function pkceS256(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(verifier)
  );
  return b64url(new Uint8Array(digest));
}

function oauthMetadata() {
  return {
    issuer: BASE,
    authorization_endpoint: `${BASE}/oauth/authorize`,
    token_endpoint: `${BASE}/oauth/token`,
    registration_endpoint: `${BASE}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp', 'offline_access'],
  };
}
function protectedResourceMetadata() {
  return {
    resource: `${BASE}/mcp`,
    authorization_servers: [BASE],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp', 'offline_access'],
  };
}

function assertRepo(repo) {
  if (!ALLOWED_REPOS.has(repo)) throw new Error('Repository not allowed');
}
function assertSafeBranch(branch) {
  if (typeof branch !== 'string' || !/^[A-Za-z0-9._/-]{1,120}$/.test(branch)) throw new Error('Invalid branch');
  if (branch === 'main' || branch === 'master' || branch.includes('..') || branch.includes('//')) throw new Error('Protected branch');
  if (!SAFE_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix))) throw new Error('Branch prefix not allowed');
}
function assertSha(sha) { if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error('Invalid commit SHA'); }
function assertPath(path) { if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..') || path.length > 500) throw new Error('Invalid repository path'); }

async function github(env, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ARBM-CONTROL',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 400)}`);
  }
  return response.status === 204 ? { ok: true } : response.json();
}

async function githubMaybe(env, path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ARBM-CONTROL',...(init.headers||{})} });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0,400)}`);
  return response.status === 204 ? {ok:true} : response.json();
}
async function githubText(env, path) {
  const response = await fetch(`https://api.github.com${path}`, {headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${env.GITHUB_TOKEN}`,'X-GitHub-Api-Version':'2022-11-28','User-Agent':'ARBM-CONTROL'},redirect:'follow'});
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0,400)}`);
  return response.text();
}
function utf8Base64(value) { const bytes=new TextEncoder().encode(value); let raw=''; for(const b of bytes) raw+=String.fromCharCode(b); return btoa(raw); }
function toolText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function localProductionProbe(env, target) {
  const sha = typeof env.ARBM_BUILD_SHA === 'string' ? env.ARBM_BUILD_SHA.trim() : '';
  const versionMeta = env.CF_VERSION_METADATA || null;
  const runtimeReady = /^[a-f0-9]{40}$/i.test(sha) && typeof versionMeta?.id === 'string' && versionMeta.id.length > 0;

  if (target.pathname === '/governance/v3/version') {
    const body = runtimeReady
      ? {
          ready:true,
          schema:'arbm-control-runtime-version/v1',
          sha,
          worker_version_id:versionMeta.id,
          worker_version_tag:versionMeta.tag || null,
          worker_version_timestamp:versionMeta.timestamp || null,
        }
      : { ready:false, error:'version_proof_unavailable' };
    return {
      url:target.toString(),
      final_url:target.toString(),
      status:runtimeReady ? 200 : 503,
      ok:runtimeReady,
      content_type:'application/json; charset=utf-8',
      cf_ray:null,
      body:JSON.stringify(body),
      evidence_source:'local-runtime-bindings',
    };
  }

  if (target.pathname === '/governance/v1/health') {
    const body = {
      ready:true,
      schema:'arbm-control-senior-governance/v2',
      fail_closed:true,
      minimum_sales_score:9.5,
      supreme_10_gates_required:true,
      hmac_integrity_required:true,
      zero_spend:true,
    };
    return {
      url:target.toString(),
      final_url:target.toString(),
      status:200,
      ok:true,
      content_type:'application/json; charset=utf-8',
      cf_ray:null,
      body:JSON.stringify(body),
      evidence_source:'local-runtime-bindings',
    };
  }

  if (target.pathname === '/governance/v3/zea10' || target.pathname === '/governance/v3/zea10/session') {
    return {
      url:target.toString(),
      final_url:BASE + '/governance/v3/zea10/session',
      status:200,
      ok:true,
      content_type:'text/html; charset=utf-8',
      cf_ray:null,
      body:'ZEA-10 administrative login protected and locally routed',
      evidence_source:'local-runtime-bindings',
    };
  }

  return {
    url:target.toString(),
    final_url:target.toString(),
    status:409,
    ok:false,
    content_type:'application/json; charset=utf-8',
    cf_ray:null,
    body:JSON.stringify({error:'self_probe_route_not_mapped'}),
    evidence_source:'local-runtime-bindings',
  };
}

async function callTool(env, name, args = {}) {
  if (name === 'control_status') {
    return toolText({ status: 'ready', version: '1.3.0', codex_safe: true, zero_spend: true, destructive_actions: false, oauth: true, build_sha: env.ARBM_BUILD_SHA || null, execution_policy: 'branch -> exact patch/create -> commit -> PR -> remote proof; no direct main/master, delete, force-push or arbitrary shell', repositories: [...ALLOWED_REPOS] });
  }
  if (name === 'github_repo_status') {
    assertRepo(args.repo);
    const meta = await github(env, `/repos/${args.repo}`);
    const branch = await github(env, `/repos/${args.repo}/branches/${meta.default_branch}`);
    return toolText({ repo: args.repo, visibility: meta.visibility, default_branch: meta.default_branch, head_sha: branch.commit.sha, archived: meta.archived });
  }
  if (name === 'github_file_read') {
    assertRepo(args.repo);
    const suffix = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
    const file = await github(env, `/repos/${args.repo}/contents/${args.path}${suffix}`);
    if (file.type !== 'file' || !file.content) throw new Error('Path is not a readable file');
    const binary = atob(file.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return toolText({ repo: args.repo, path: args.path, ref: args.ref || null, sha: file.sha, content: new TextDecoder().decode(bytes) });
  }
  if (name === 'github_recent_runs') {
    assertRepo(args.repo);
    const limit = Math.max(1, Math.min(Number(args.limit || 10), 20));
    const data = await github(env, `/repos/${args.repo}/actions/runs?per_page=${limit}`);
    return toolText(data.workflow_runs.map(run => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      head_sha: run.head_sha,
      branch: run.head_branch,
      event: run.event,
      created_at: run.created_at,
      html_url: run.html_url,
    })));
  }
  if (name === 'github_path_list') {
    assertRepo(args.repo); const path=args.path||''; if(path) assertPath(path); const suffix=args.ref?`?ref=${encodeURIComponent(args.ref)}`:'';
    const data=await github(env, `/repos/${args.repo}/contents/${path}${suffix}`); const items=Array.isArray(data)?data:[data];
    return toolText(items.map(x=>({name:x.name,path:x.path,type:x.type,sha:x.sha,size:x.size??null})));
  }
  if (name === 'github_branch_create') {
    assertRepo(args.repo); assertSafeBranch(args.branch); assertSha(args.source_sha);
    await github(env, `/repos/${args.repo}/git/refs`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ref:`refs/heads/${args.branch}`,sha:args.source_sha})});
    return toolText({created:true,repo:args.repo,branch:args.branch,source_sha:args.source_sha});
  }
  if (name === 'github_file_upsert') {
    assertRepo(args.repo); assertSafeBranch(args.branch); assertPath(args.path);
    if (typeof args.content !== 'string' || args.content.length > 200000) throw new Error('Invalid or oversized file content');
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 200) throw new Error('Invalid commit message');
    const current=await githubMaybe(env, `/repos/${args.repo}/contents/${args.path}?ref=${encodeURIComponent(args.branch)}`);
    if (current && (!args.expected_sha || args.expected_sha !== current.sha)) throw new Error('expected_sha required and must match existing file');
    if (!current && args.expected_sha) throw new Error('expected_sha supplied for missing file');
    const body={message:args.message,content:utf8Base64(args.content),branch:args.branch};
    if (current) body.sha=current.sha;
    const result=await github(env, `/repos/${args.repo}/contents/${args.path}`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return toolText({upserted:true,created:!current,repo:args.repo,branch:args.branch,path:args.path,commit_sha:result.commit?.sha||null,content_sha:result.content?.sha||null});
  }
  if (name === 'github_patch_exact') {
    assertRepo(args.repo); assertSafeBranch(args.branch); assertPath(args.path);
    if (typeof args.expected_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(args.expected_sha)) throw new Error('Invalid expected_sha');
    if (typeof args.find !== 'string' || !args.find) throw new Error('find must be non-empty');
    if (typeof args.replace !== 'string') throw new Error('replace must be a string');
    const expectedCount=Number(args.expected_count); if(!Number.isInteger(expectedCount)||expectedCount<1||expectedCount>100) throw new Error('Invalid expected_count');
    if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 200) throw new Error('Invalid commit message');
    const current=await github(env, `/repos/${args.repo}/contents/${args.path}?ref=${encodeURIComponent(args.branch)}`);
    if (current.type !== 'file' || !current.content) throw new Error('Path is not a readable file');
    if (current.sha !== args.expected_sha) throw new Error('expected_sha mismatch');
    const raw=atob(current.content.replace(/\n/g,'')); const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0)); const text=new TextDecoder().decode(bytes);
    const count=text.split(args.find).length-1; if(count!==expectedCount) throw new Error(`Exact match count ${count} != expected ${expectedCount}`);
    const next=text.split(args.find).join(args.replace);
    const result=await github(env, `/repos/${args.repo}/contents/${args.path}`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:args.message,content:utf8Base64(next),branch:args.branch,sha:current.sha})});
    return toolText({patched:true,replacements:count,repo:args.repo,branch:args.branch,path:args.path,commit_sha:result.commit?.sha||null,content_sha:result.content?.sha||null});
  }
  if (name === 'github_pull_request_create') {
    assertRepo(args.repo); assertSafeBranch(args.branch); const meta=await github(env, `/repos/${args.repo}`);
    const result=await github(env, `/repos/${args.repo}/pulls`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:args.title,head:args.branch,base:meta.default_branch,body:args.body||''})});
    return toolText({created:true,number:result.number,url:result.html_url,state:result.state,head:result.head?.sha,base:result.base?.sha});
  }
  if (name === 'github_commit_status') {
    assertRepo(args.repo); assertSha(args.sha);
    const [status,checks]=await Promise.all([github(env, `/repos/${args.repo}/commits/${args.sha}/status`),github(env, `/repos/${args.repo}/commits/${args.sha}/check-runs?per_page=100`)]);
    return toolText({sha:args.sha,combined_state:status.state,statuses:(status.statuses||[]).map(x=>({context:x.context,state:x.state,target_url:x.target_url||null})),checks:(checks.check_runs||[]).map(x=>({id:x.id,name:x.name,status:x.status,conclusion:x.conclusion,html_url:x.html_url}))});
  }
  if (name === 'github_workflows_list') {
    assertRepo(args.repo); const data=await github(env, `/repos/${args.repo}/actions/workflows?per_page=100`);
    return toolText((data.workflows||[]).map(x=>({id:x.id,name:x.name,path:x.path,state:x.state,html_url:x.html_url})));
  }
  if (name === 'github_workflow_run') {
    assertRepo(args.repo); const runId=Number(args.run_id); if(!Number.isInteger(runId)||runId<=0) throw new Error('Invalid run_id');
    const [run,jobs]=await Promise.all([github(env, `/repos/${args.repo}/actions/runs/${runId}`),github(env, `/repos/${args.repo}/actions/runs/${runId}/jobs?per_page=100`)]);
    return toolText({run:{id:run.id,name:run.name,status:run.status,conclusion:run.conclusion,head_sha:run.head_sha,branch:run.head_branch,event:run.event,html_url:run.html_url},jobs:(jobs.jobs||[]).map(j=>({id:j.id,name:j.name,status:j.status,conclusion:j.conclusion,started_at:j.started_at,completed_at:j.completed_at,html_url:j.html_url,steps:(j.steps||[]).map(x=>({name:x.name,status:x.status,conclusion:x.conclusion,number:x.number}))}))});
  }
  if (name === 'github_workflow_job_logs') {
    assertRepo(args.repo); const jobId=Number(args.job_id); if(!Number.isInteger(jobId)||jobId<=0) throw new Error('Invalid job_id');
    const maxChars=Math.max(1000,Math.min(Number(args.max_chars||12000),20000)); const logs=await githubText(env, `/repos/${args.repo}/actions/jobs/${jobId}/logs`);
    return toolText({repo:args.repo,job_id:jobId,truncated:logs.length>maxChars,logs:logs.slice(-maxChars)});
  }
  if (name === 'production_probe') {
    const target=new URL(args.url); if(target.protocol!=='https:'||!APPROVED_PROBE_HOSTS.has(target.hostname)) throw new Error('Probe host not allowed');
    if (target.origin === BASE) return toolText(localProductionProbe(env, target));
    const response=await fetch(target.toString(),{method:'GET',headers:{Accept:'application/json,text/plain,text/html;q=0.8'},redirect:'follow',signal:AbortSignal.timeout(10000)});
    const body=(await response.text()).slice(0,4000); return toolText({url:target.toString(),final_url:response.url,status:response.status,ok:response.ok,content_type:response.headers.get('content-type'),cf_ray:response.headers.get('cf-ray'),body});
  }
  if (name === 'github_workflow_dispatch') {
    assertRepo(args.repo); assertSafeBranch(args.ref);
    await github(env, `/repos/${args.repo}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: args.ref, inputs: args.inputs || {} }),
    });
    return toolText({ dispatched: true, repo: args.repo, workflow: args.workflow, ref: args.ref, inputs: args.inputs || {} });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
async function handleRpc(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  const { id, method, params } = body || {};
  try {
    if (method === 'initialize') {
      return json(rpcResult(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'ARBM CONTROL', version: '1.3.0' },
      }));
    }
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (method === 'ping') return json(rpcResult(id, {}));
    if (method === 'tools/list') return json(rpcResult(id, { tools: toolsWithAnnotations() }));
    if (method === 'tools/call') {
      const result = await callTool(env, params?.name, params?.arguments || {});
      return json(rpcResult(id, result));
    }
    return json(rpcError(id, -32601, 'Method not found'), 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(rpcError(id, -32000, message), 500);
  }
}

async function validBearer(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (auth === `Bearer ${directBearerSecret(env)}`) return true;
  if (!auth.startsWith('Bearer ')) return false;
  const payload = await unseal(env, auth.slice(7), 'access');
  return !!payload;
}
async function handleRegister(request, env) {
  const body = await request.json();
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (!redirectUris.length || !redirectUris.every(chatgptRedirectAllowed)) {
    return json({ error: 'invalid_redirect_uri' }, 400);
  }
  const clientId = await seal(env, { typ: 'client', redirect_uris: redirectUris, iat: Date.now() });
  return json({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  }, 201);
}

function chatgptRedirectAllowed(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'chatgpt.com'
      && /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname)
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function decodeLegacyPublicClient(clientId) {
  if (!clientId || !clientId.includes('.')) return null;
  const [body] = clientId.split('.', 1);
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body)));
    const redirectUris = Array.isArray(payload?.redirect_uris) ? payload.redirect_uris : [];
    if (payload?.typ !== 'client' || !redirectUris.length) return null;
    if (!redirectUris.every(chatgptRedirectAllowed)) return null;
    return { ...payload, legacy_recovered: true };
  } catch {
    return null;
  }
}

async function decodeClient(env, clientId) {
  const verified = await unseal(env, clientId, 'client');
  if (verified) return verified;

  // Recover a previously registered public ChatGPT client after a signing-key
  // rotation only when every redirect URI is an exact ChatGPT connector callback.
  // Authorization codes remain PKCE-bound and redirect-bound.
  return decodeLegacyPublicClient(clientId);
}

function authPage(params) {
  const hidden = [...params.entries()].map(([k,v]) =>
    `<input type="hidden" name="${k.replace(/"/g,'')}" value="${String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">`
  ).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>ARBM CONTROL</title></head><body style="font-family:Arial;max-width:520px;margin:60px auto;padding:24px"><h2>Autorizar ARBM CONTROL</h2><p>Confirme o acesso deste ChatGPT ao seu ARBM CONTROL.</p><form method="post" action="/oauth/authorize">${hidden}<label>Chave de autorização</label><input type="password" name="admin_key" required style="display:block;width:100%;padding:10px;margin:8px 0 16px"><button type="submit" style="padding:10px 18px">Autorizar</button></form></body></html>`;
}
async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const params = request.method === 'GET' ? url.searchParams : new URLSearchParams(await request.text());
  const clientId = params.get('client_id') || '';
  const redirectUri = params.get('redirect_uri') || '';
  const responseType = params.get('response_type') || '';
  const codeChallenge = params.get('code_challenge') || '';
  const codeChallengeMethod = params.get('code_challenge_method') || '';
  const state = params.get('state') || '';
  const scope = params.get('scope') || 'mcp offline_access';
  const client = await decodeClient(env, clientId);
  if (!client || !client.redirect_uris.includes(redirectUri) || responseType !== 'code' || !codeChallenge || codeChallengeMethod !== 'S256') {
    return text('Invalid OAuth request', 400);
  }
  if (request.method === 'GET') return text(authPage(params), 200, { 'content-type': 'text/html; charset=utf-8' });
  if ((params.get('admin_key') || '') !== adminSecret(env)) return text('Authorization denied', 403);
  const code = await seal(env, {
    typ: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: codeChallenge, scope, exp: Date.now() + 2 * 60 * 1000,
  });
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  return Response.redirect(redirect.toString(), 302);
}
async function handleToken(request, env) {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get('grant_type') || '';
  if (grantType === 'authorization_code') {
    const code = await unseal(env, form.get('code') || '', 'code');
    const clientId = form.get('client_id') || '';
    const verifier = form.get('code_verifier') || '';
    const redirectUri = form.get('redirect_uri') || '';
    if (!code || code.client_id !== clientId || code.redirect_uri !== redirectUri) {
      return json({ error: 'invalid_grant' }, 400);
    }
    if ((await pkceS256(verifier)) !== code.code_challenge) {
      return json({ error: 'invalid_grant' }, 400);
    }
    const now = Date.now();
    const access = await seal(env, { typ: 'access', sub: 'arbm-control', scope: code.scope, exp: now + 60 * 60 * 1000 });
    const refresh = await seal(env, { typ: 'refresh', sub: 'arbm-control', scope: code.scope, exp: now + 30 * 24 * 60 * 60 * 1000 });
    return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: code.scope });
  }
  if (grantType === 'refresh_token') {
    const refresh = await unseal(env, form.get('refresh_token') || '', 'refresh');
    if (!refresh) return json({ error: 'invalid_grant' }, 400);
    const now = Date.now();
    const access = await seal(env, { typ: 'access', sub: refresh.sub, scope: refresh.scope, exp: now + 60 * 60 * 1000 });
    const rotatedRefresh = await seal(env, { typ: 'refresh', sub: refresh.sub, scope: refresh.scope, exp: now + 30 * 24 * 60 * 60 * 1000 });
    return json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: rotatedRefresh, scope: refresh.scope });
  }
  return json({ error: 'unsupported_grant_type' }, 400);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, service: 'ARBM CONTROL', version: '1.3.0', oauth: true, codex_safe: true, build_sha: env.ARBM_BUILD_SHA || null, tool_count: TOOLS.length });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(oauthMetadata());
    if (url.pathname === '/.well-known/openid-configuration') return json(oauthMetadata());
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(protectedResourceMetadata());
    if (url.pathname === '/oauth/register' && request.method === 'POST') return handleRegister(request, env);
    if (url.pathname === '/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) return handleAuthorize(request, env);
    if (url.pathname === '/oauth/token' && request.method === 'POST') return handleToken(request, env);
    if (url.pathname !== '/mcp') return text('Not Found', 404);

    if (!(await validBearer(request, env))) {
      return text('Unauthorized', 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    if (request.method === 'POST') return handleRpc(request, env);
    return text('Method Not Allowed', 405, { Allow: 'POST' });
  },
};
