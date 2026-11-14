// NC-V34-04/05: o ensaio pré-merge da prévia só roda para o HEAD exato de um PR aberto e autorizado, com a
// autorização verificada pelo código do gh-pages (antes e depois da aprovação humana do environment) e sem
// nenhuma credencial de publicação.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
import {autorizarEnsaio} from '../scripts/ci/autorizar-ensaio.mjs';

const REPO='arbmsistone-lab/zevanory-public-mirror',SHA='7098de319ed6c0df9ae8f0a1b32678c5cd9ba180',ETQ='owner-approved:7098de319ed6';
const pr=(o={})=>({number:1053,state:'open',head:{sha:SHA,repo:{full_name:REPO}},base:{ref:'gh-pages'},labels:[{name:ETQ}],...o});
const ev=(event,name=ETQ,login='arbmsistone-lab')=>({event,label:{name},actor:{login},created_at:'2026-11-14T15:57:00Z'});
function gh({lista=[pr()],atual=pr(),eventos=[ev('labeled')],status=200}={}){
 const calls=[];return {calls,fetchImpl:async(url,o)=>{calls.push(url);assert.equal(o.headers.authorization,'Bearer t');
  if(status!==200)return {status,json:async()=>({})};
  if(url.includes(`/commits/${SHA}/pulls`))return {status:200,json:async()=>lista};
  if(/\/pulls\/1053$/.test(url))return {status:200,json:async()=>atual};
  if(url.includes('/issues/1053/events'))return {status:200,json:async()=>eventos};
  return {status:404,json:async()=>({})};}};}
const tenta=async(o,args={})=>{const g=gh(o);try{return await autorizarEnsaio({sha:SHA,repo:REPO,token:'t',fetchImpl:g.fetchImpl,...args});}catch(e){return e.message;}};

test('NC-V34-05: aceita só o HEAD exato de 1 PR aberto, do próprio repo, base gh-pages, com a etiqueta do SHA aplicada pelo dono',async()=>{
 const ok=await tenta();assert.equal(ok.ok,true);assert.equal(ok.pr,1053);assert.equal(ok.etiqueta,ETQ);
});
test('NC-V34-05 adversarial: SHA inválido, sem PR, fork, base errada, PR fechado, HEAD mudou, etiqueta de outro SHA, removida ou de outra conta',async()=>{
 assert.equal(await tenta({},{sha:SHA.toUpperCase()}),'ensaio_sha_invalido');
 assert.equal(await tenta({},{sha:SHA.slice(0,39)}),'ensaio_sha_invalido');
 assert.equal(await tenta({},{sha:SHA+'\nfoo'}),'ensaio_sha_invalido');
 assert.equal(await tenta({lista:[]}),'ensaio_sem_pr_unico:0','commit que não é HEAD de PR aberto');
 assert.equal(await tenta({lista:[pr({state:'closed'})]}),'ensaio_sem_pr_unico:0','PR fechado/revogado');
 assert.equal(await tenta({lista:[pr({head:{sha:'a'.repeat(40),repo:{full_name:REPO}}})]}),'ensaio_sem_pr_unico:0','commit antigo do PR (substituído)');
 assert.equal(await tenta({lista:[pr(),pr({number:9})]}),'ensaio_sem_pr_unico:2');
 assert.equal(await tenta({lista:[pr({head:{sha:SHA,repo:{full_name:'outro/fork'}}})]}),'ensaio_pr_de_fork');
 assert.equal(await tenta({lista:[pr({base:{ref:'main'}})]}),'ensaio_base_invalida');
 assert.equal(await tenta({atual:pr({head:{sha:'b'.repeat(40),repo:{full_name:REPO}}})}),'ensaio_head_mudou','push entre a busca e a releitura');
 assert.equal(await tenta({atual:pr({labels:[{name:'owner-approved:aaaaaaaaaaaa'}]})}),'ensaio_sem_etiqueta_do_sha','etiqueta de outro commit não serve');
 assert.equal(await tenta({atual:pr({labels:[]})}),'ensaio_sem_etiqueta_do_sha');
 assert.equal(await tenta({eventos:[ev('labeled'),ev('unlabeled')]}),'ensaio_etiqueta_removida');
 assert.equal(await tenta({eventos:[]}),'ensaio_etiqueta_removida','etiqueta sem evento de aplicação');
 assert.equal(await tenta({eventos:[ev('labeled',ETQ,'outra-conta')]}),'ensaio_etiqueta_sem_autoridade');
 assert.equal(await tenta({eventos:[ev('labeled'),ev('unlabeled'),ev('labeled',ETQ,'outra-conta')]}),'ensaio_etiqueta_sem_autoridade','reaplicada por quem não é o dono');
 assert.equal(await tenta({status:403}),'ensaio_github_ilegivel','GitHub ilegível = recusa (falha fechada)');
 assert.equal(await autorizarEnsaio({sha:SHA,repo:REPO,token:'',fetchImpl:async()=>{throw Error('não deveria chamar');}}).catch(e=>e.message),'ensaio_contexto_invalido');
});
test('NC-V34-04/05: workflow — autorização com código do gh-pages sem segredo, aprovação humana do environment, reverificação, checkout do SHA exato, segredo só no render',()=>{
 const y=readTextNormalized('.github/workflows/shorts-v2-amostras.yml');
 const job=n=>{const i=y.indexOf(`\n  ${n}:\n`);assert.ok(i>0,n);const r=y.slice(i+1);const j=r.slice(1).search(/\n  [a-z][\w-]*:\n/);return j<0?r:r.slice(0,j+1);};
 assert.deepEqual([...new Set([...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m=>m[1]))],['GEMINI_API_KEY'],'nenhum outro segredo no workflow');
 assert.match(y,/\npermissions:\n  contents: read\n/);assert.doesNotMatch(y,/:\s*write\b|id-token/);
 const aut=job('autorizar-ensaio'),ens=job('ensaio'),prev=job('previa');
 assert.doesNotMatch(aut,/secrets\.|environment:/,'1ª camada sem segredo e sem environment');
 assert.match(aut,/node scripts\/ci\/autorizar-ensaio\.mjs/);assert.doesNotMatch(aut,/ref: \$\{\{ inputs\.sha_ensaio/,'1ª camada não roda código do PR');
 assert.match(prev,/inputs\.sha_ensaio == ''/,'prévia normal nunca roda com sha_ensaio');
 assert.match(ens,/needs: autorizar-ensaio/);assert.match(ens,/environment: ensaio-shorts/);
 const ordem=['path: confiavel','node confiavel/scripts/ci/autorizar-ensaio.mjs','ref: ${{ needs.autorizar-ensaio.outputs.sha }}','git -C ensaio rev-parse HEAD','secrets.GEMINI_API_KEY'];
 let pos=-1;for(const o of ordem){const p=ens.indexOf(o);assert.ok(p>pos,'ordem: '+o);pos=p;}
 assert.equal((ens.match(/secrets\./g)||[]).length,1,'segredo em um único passo');
 const render=ens.slice(ens.indexOf('Render the authorized SHA'));assert.match(render.slice(0,render.indexOf('upload-artifact')),/GEMINI_API_KEY: \$\{\{ secrets\.GEMINI_API_KEY \}\}/);
 assert.doesNotMatch(ens,/GITHUB_TOKEN: \$\{\{ github\.token \}\}[\s\S]*Render the authorized SHA[\s\S]*GITHUB_TOKEN/,'token não chega ao código do PR');
 const padrao=new RegExp(ens.match(/grep -Eq '(\^\(YOU[^']+)'/)[1]);
 for(const v of ['YOUTUBE_REFRESH_TOKEN','META_ACCESS_TOKEN','CLOUDFLARE_API_TOKEN','KV_NAMESPACE_ID','HOTMART_TOKEN','CRIATIVOS_DECISAO_KEY'])assert.ok(padrao.test(v),'guarda pega '+v);
 for(const v of ['GEMINI_API_KEY','RUNNER_TEMP','PATH'])assert.ok(!padrao.test(v),'guarda não bloqueia '+v);
 assert.doesNotMatch(y,/upload-short|youtube-daily-short|wrangler|kv:key|publishShort/);
});

// ---- Modo PR (#1055; contra-auditoria GPT-6): 1 etiqueta do dono, 24 h, máx. 8 execuções do workflow próprio ----
const ETP='ensaio-autorizado-pr',AGORA=Date.parse('2026-11-14T21:00:00Z');
const ENV_OK={name:'ensaio-shorts-pr',deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}};
const POL_OK={total_count:1,branch_policies:[{name:'gh-pages',type:'branch'}]};
function ghPR({atual=pr({labels:[{name:ETP}],user:{login:'arbmsistone-lab'}}),eventos=[{...ev('labeled',ETP),created_at:'2026-11-14T20:00:00Z'}],runs={total_count:3,workflow_runs:[{}]},runsStatus=200,env=ENV_OK,envStatus=200,pol=POL_OK}={}){
 const urls=[];const f=async(url)=>{urls.push(url);
  if(url.includes(`/commits/${SHA}/pulls`))return {status:200,json:async()=>[pr()]};
  if(/\/pulls\/1053$/.test(url))return {status:200,json:async()=>atual};
  if(url.includes('/issues/1053/events'))return {status:200,json:async()=>eventos};
  if(url.endsWith('/environments/ensaio-shorts-pr'))return {status:envStatus,json:async()=>env};
  if(url.includes('/environments/ensaio-shorts-pr/deployment-branch-policies'))return {status:200,json:async()=>pol};
  if(url.includes('/actions/workflows/shorts-ensaio-pr.yml/runs?created=>=2026-11-13T21:00:00.000Z'))return {status:runsStatus,json:async()=>runs};
  return {status:404,json:async()=>({})};};f.urls=urls;return f;}
const tentaPR=async(o={},args={})=>{try{return await autorizarEnsaio({sha:SHA,repo:REPO,token:'t',fetchImpl:ghPR(o),agora:AGORA,modo:'pr',...args});}catch(e){return e.message;}};
test('modo PR: etiqueta do dono autoriza o HEAD atual; conta só o workflow próprio pelo total_count; modo SHA intacto e padrão',async()=>{
 const ok=await tentaPR();assert.equal(ok.ok,true);assert.equal(ok.modo,'pr');assert.equal(ok.sha,SHA);assert.equal(ok.execucoes_24h,3);
 // o modo padrão continua sendo o SHA: a etiqueta do PR NÃO serve no workflow antigo
 assert.equal(await tentaPR({},{modo:'sha'}),'ensaio_sem_etiqueta_do_sha');
 assert.equal(await tentaPR({},{modo:'x'}),'ensaio_modo_invalido');
 const g=ghPR();await autorizarEnsaio({sha:SHA,repo:REPO,token:'t',fetchImpl:g,agora:AGORA,modo:'pr'});
 assert.ok(g.urls.some(u=>u.includes('/actions/workflows/shorts-ensaio-pr.yml/runs?created=>=')),'conta execuções do workflow do modo PR');
 assert.ok(!g.urls.some(u=>u.includes('shorts-v2-amostras.yml')),'não mistura com prévias/amostras');
});
test('modo PR adversarial: etiqueta (expirada/removida/outra conta/data), autor, HEAD, limite, contagem incompleta, environment ausente ou aberto',async()=>{
 assert.equal(await tentaPR({eventos:[{...ev('labeled',ETP),created_at:'2026-11-13T20:59:00Z'}]}),'ensaio_etiqueta_pr_expirada');
 assert.equal(await tentaPR({eventos:[{...ev('labeled',ETP),created_at:'2026-11-14T20:00:00Z'},ev('unlabeled',ETP)]}),'ensaio_etiqueta_removida');
 assert.equal(await tentaPR({eventos:[{...ev('labeled',ETP,'outra-conta'),created_at:'2026-11-14T20:00:00Z'}]}),'ensaio_etiqueta_sem_autoridade');
 assert.equal(await tentaPR({eventos:[{...ev('labeled',ETP),created_at:'2026-11-15T20:00:00Z'}]}),'ensaio_etiqueta_data_invalida');
 assert.equal(await tentaPR({eventos:[{...ev('labeled',ETP),created_at:'lixo'}]}),'ensaio_etiqueta_data_invalida');
 assert.equal(await tentaPR({atual:pr({labels:[{name:ETP}],user:{login:'outra-conta'}})}),'ensaio_pr_de_outro_autor');
 assert.equal(await tentaPR({atual:pr({labels:[{name:'ensaio-autorizado-pr-x'}],user:{login:'arbmsistone-lab'}})}),'ensaio_sem_etiqueta_pr','nome parecido não vale');
 assert.equal(await tentaPR({atual:pr({labels:[{name:ETP}],user:{login:'arbmsistone-lab'},head:{sha:'c'.repeat(40),repo:{full_name:REPO}}})}),'ensaio_head_mudou');
 // limite: total_count inclui a execução corrente; 8 passa, 9 recusa
 assert.equal((await tentaPR({runs:{total_count:8,workflow_runs:[]}})).ok,true);
 assert.equal(await tentaPR({runs:{total_count:9,workflow_runs:[{}]}}),'ensaio_limite_diario:9>8');
 // resposta incompleta/inconsistente da API = recusa (inclui cancelamentos: toda execução criada conta)
 assert.equal(await tentaPR({runs:{workflow_runs:Array(3).fill({})}}),'ensaio_contagem_ilegivel','sem total_count');
 assert.equal(await tentaPR({runs:{total_count:'3'}}),'ensaio_contagem_ilegivel');
 assert.equal(await tentaPR({runs:{total_count:0}}),'ensaio_contagem_ilegivel','a própria execução tem de aparecer');
 assert.equal(await tentaPR({runsStatus:500}),'ensaio_github_ilegivel');
 // environment: ausente, sem restrição de ramo, com ramos protegidos, ramo diferente ou mais de um
 assert.equal(await tentaPR({envStatus:404}),'ensaio_github_ilegivel','environment inexistente');
 assert.equal(await tentaPR({env:{name:'ensaio-shorts-pr',deployment_branch_policy:null}}),'ensaio_environment_invalido','sem restrição de ramo');
 assert.equal(await tentaPR({env:{name:'ensaio-shorts-pr',deployment_branch_policy:{protected_branches:true,custom_branch_policies:false}}}),'ensaio_environment_invalido');
 assert.equal(await tentaPR({pol:{total_count:1,branch_policies:[{name:'*',type:'branch'}]}}),'ensaio_environment_invalido','curinga');
 assert.equal(await tentaPR({pol:{total_count:2,branch_policies:[{name:'gh-pages'},{name:'main'}]}}),'ensaio_environment_invalido');
 assert.equal(await tentaPR({pol:{total_count:1,branch_policies:[{name:'gh-pages',type:'tag'}]}}),'ensaio_environment_invalido','tag não é ramo');
});
test('workflow do modo PR: a chave só existe nos jobs voz/júri (código do gh-pages); o código do PR roda sem segredo nem token',()=>{
 const y=readTextNormalized('.github/workflows/shorts-ensaio-pr.yml');
 const job=n=>{const i=y.indexOf(`\n  ${n}:\n`);assert.ok(i>0,n);const r=y.slice(i+1);const j=r.slice(1).search(/\n  [a-z][\w-]*:\n/);return j<0?r:r.slice(0,j+1);};
 assert.match(y,/^on:\n  workflow_dispatch:\n/m);assert.doesNotMatch(y,/^  (schedule|push|pull_request|pull_request_target|workflow_run):/m);
 assert.match(y,/\npermissions:\n  contents: read\n/);assert.doesNotMatch(y,/:\s*write\b|id-token/);
 assert.match(y,/concurrency:\n  group: shorts-ensaio-pr\n  cancel-in-progress: false/,'execuções em série: sem corrida na contagem');
 assert.deepEqual([...new Set([...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m=>m[1]))],['GEMINI_API_KEY']);
 const nomes=[...y.matchAll(/^  ([a-z][\w-]*):\n/gm)].map(m=>m[1]).filter(n=>!['workflow_dispatch','group'].includes(n));
 assert.deepEqual(nomes,['autorizar','pedido','voz','render','juri']);
 for(const n of nomes)assert.match(job(n),/if: \$\{\{ github\.ref == 'refs\/heads\/gh-pages'/,'todo job só no gh-pages: '+n);
 const pr_=['pedido','render'],conf=['autorizar','voz','juri'];
 for(const n of pr_){const j=job(n);
  assert.match(j,/ref: \$\{\{ needs\.autorizar\.outputs\.sha \}\}/,n+' roda o SHA autorizado');assert.match(j,/git rev-parse HEAD\)" = "\$SHA_ENSAIO"/);
  assert.doesNotMatch(j,/secrets\.|environment:|github\.token|GITHUB_TOKEN:/,n+': sem segredo, sem environment, sem token');
  assert.match(j,/persist-credentials: false/);}
 for(const n of conf){const j=job(n);
  assert.doesNotMatch(j,/\n\s+ref: \$\{\{|ensaio-fases\.mjs|scripts\/shorts-v3/,n+': nunca faz checkout nem executa código do PR');
  assert.match(j,/persist-credentials: false/);}
 for(const n of ['voz','juri'])assert.match(job(n),/environment: ensaio-shorts-pr\n/);
 assert.doesNotMatch(job('autorizar'),/secrets\.|environment:/);assert.match(job('autorizar'),/MODO_ENSAIO: pr/);
 assert.match(job('voz'),/node scripts\/ci\/ensaio-voz\.mjs/);assert.match(job('juri'),/node scripts\/ci\/ensaio-juri\.mjs/);
 assert.match(job('render'),/\^\(GEMI\[N\]I\|YOU\[T\]UBE/,'guarda: nenhuma credencial (nem Gemini, nem token) na máquina do PR');
 assert.doesNotMatch(y,/upload-short|youtube-daily-short|wrangler|kv:key|publishShort/);
 for(const u of y.matchAll(/uses: ([^\s]+)/g))assert.match(u[1],/@[0-9a-f]{40}$/,'ação fixada por SHA: '+u[1]);
});
