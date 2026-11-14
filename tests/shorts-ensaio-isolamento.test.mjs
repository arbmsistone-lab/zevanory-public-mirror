// NC-V34-04: o ensaio pré-merge (job previa com sha_ensaio) não herda privilégios de produção.
import test from 'node:test';import assert from 'node:assert/strict';import {readTextNormalized} from './helpers/text.mjs';
test('ensaio da prévia: só GEMINI_API_KEY, contents read, SHA validado, prova de ausência de credenciais de publicação',()=>{
 const y=readTextNormalized('.github/workflows/shorts-v2-amostras.yml');
 const previa=y.slice(y.indexOf('\n  previa:'));
 assert.deepEqual([...new Set([...y.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m=>m[1]))],['GEMINI_API_KEY'],'nenhum outro segredo no workflow');
 assert.match(y,/\npermissions:\n  contents: read\n/);assert.doesNotMatch(y,/contents:\s*write|id-token|actions:\s*write/);
 assert.match(previa,/grep -Eq '\^\[0-9a-f\]\{40\}\$'/);assert.match(previa,/ref: \$\{\{ inputs\.sha_ensaio \|\| github\.sha \}\}/);
 assert.ok(previa.indexOf('Validate rehearsal SHA')<previa.indexOf('actions/checkout'),'SHA validado antes do checkout');
 const padrao=new RegExp(previa.match(/grep -Eq '(\^\(YOU[^']+)'/)[1]);
 for(const v of ['YOUTUBE_REFRESH_TOKEN','META_ACCESS_TOKEN','CLOUDFLARE_API_TOKEN','KV_NAMESPACE_ID','HOTMART_TOKEN','CRIATIVOS_DECISAO_KEY'])assert.ok(padrao.test(v),'guarda pega '+v);
 for(const v of ['GEMINI_API_KEY','RUNNER_TEMP','PATH'])assert.ok(!padrao.test(v),'guarda não bloqueia '+v);
 assert.ok(previa.indexOf('Prove no publication credentials')<previa.indexOf('Render actual selected voice'));
 assert.doesNotMatch(previa,/upload-short|youtube-daily-short|wrangler|kv:key|publishShort/);
 assert.match(previa,/if: \$\{\{ github\.ref == 'refs\/heads\/gh-pages' && inputs\.modo == 'previa' \}\}/,'dispatch só a partir do gh-pages (segredos do environment)');
});
