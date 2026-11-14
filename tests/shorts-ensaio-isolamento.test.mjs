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
