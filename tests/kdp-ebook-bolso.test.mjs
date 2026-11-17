// KDP (Plano Mestre, canal 14; ordem executiva 14/11: só preparação): e-book de bolso gerado SÓ do manual real do kit,
// conferido por SHA-256, sem reescrever o texto das lições; formulários omitidos; nada é publicado (sem API no KDP).
// O manual é o produto pago e não é versionado: aqui o parser roda com blocos sintéticos e a trava do hash com bytes falsos.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readTextNormalized,normalizeEol} from './helpers/text.mjs';import {requireTool} from './helpers/toolchain.mjs';
const py=(code)=>spawnSync('python3',['-I','-c','import sys;sys.path.insert(0,"scripts/kdp");import ebook_bolso as k, json\n'+code],{encoding:'utf8'});
const cfg=JSON.parse(readTextNormalized('data/kdp/lcx-bolso.json'));
test('configuração: fonte por SHA-256, 6 módulos do manual, formulários omitidos, avisos e pendências do proprietário',()=>{
 assert.match(cfg.fonte.sha256,/^[0-9a-f]{64}$/);assert.equal(cfg.fonte.arquivo,'ZEVANORY_Lucro_e_Caixa_Manual_v1.3.docx');
 assert.deepEqual(cfg.modulos,['01','02','03','07','09','12']);assert.deepEqual(cfg.omitir_secoes,['Registro pessoal da atividade']);
 assert.ok(cfg.nota_de_uso.some(t=>/não garante renda/.test(t)),'aviso de não promessa');
 assert.ok(cfg.fechamento.some(t=>/18 módulos/.test(t)&&/sete calculadoras/.test(t)),'fechamento descreve o kit real');
 assert.equal(cfg.kdp.palavras_chave.length,7,'KDP aceita 7 palavras-chave');assert.deepEqual([cfg.capa.largura,cfg.capa.altura],[1600,2560]);
 assert.doesNotMatch(JSON.stringify(cfg),/garantid|fique rico|renda extra/i);
});
test('parser: lições copiadas do manual sem reescrita; formulário omitido; módulo ausente ou vazio reprova',()=>{
 requireTool('python3');
 const r=py(`b=[("Heading 1","Mapa do manual"),("Normal","01 | X"),("Heading 1","01 | Primeira lição"),("Subtitle","Sub um."),("Heading 2","Entenda"),("Normal","Texto um."),("Heading 2","Aplicação em sequência"),("Normal","1. Passo A."),("List Bullet","item"),("Heading 2","Registro pessoal da atividade"),("Normal","____"),("Heading 1","02 | Segunda"),("Heading 2","Entenda"),("Normal","Dois.")]
m=k.modulos(b)
s=k.selecionar(m,{"modulos":["01"],"omitir_secoes":["Registro pessoal da atividade"]})
x=k.capitulo(s[0],1,"Sem a planilha: papel.")
print(json.dumps({"mods":sorted(m),"secoes":[t for t,_ in s[0]["secoes"]],"tem_passo":'class="passo"' in x,"tem_ul":"<ul><li>item</li></ul>" in x,"sub":s[0]["subtitulo"],"form":"____" in x,"nota_apos_passo1":x.index("Nota desta edição")>x.index("1. Passo A.") and x.count("Nota desta edição")==1,"html":x}))
for c in (["03"],):
    try: k.selecionar(m,{"modulos":c,"omitir_secoes":[]})
    except SystemExit as e: print(e)
m2=k.modulos([("Heading 1","05 | Vazio"),("Heading 2","Entenda")])
try: k.selecionar(m2,{"modulos":["05"],"omitir_secoes":[]})
except SystemExit as e: print(e)`);
 assert.equal(r.status,0,r.stderr);const [j,a,b]=normalizeEol(r.stdout).trim().split('\n');const o=JSON.parse(j);
 assert.deepEqual(o.mods,['01','02']);assert.deepEqual(o.secoes,['Entenda','Aplicação em sequência']);
 assert.equal(o.tem_passo,true);assert.equal(o.nota_apos_passo1,true,'nota editorial logo após o 1º passo, marcada');assert.ok(o.html.includes('1. Passo A.'),'texto do manual intacto');assert.equal(o.tem_ul,true);assert.equal(o.sub,'Sub um.');assert.equal(o.form,false);
 assert.equal(a,'kdp_modulo_ausente:03');assert.equal(b,'kdp_modulo_sem_texto:05');
});
test('trava: manual diferente do registrado (SHA-256) não vira livro',()=>{
 requireTool('python3');
 const d=mkdtempSync(join(tmpdir(),'kdp-'));try{const f=join(d,'falso.docx');writeFileSync(f,'nao e o manual');
  const r=spawnSync('python3',['-I','scripts/kdp/ebook_bolso.py','.','data/kdp/lcx-bolso.json',f,join(d,'out')],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/kdp_manual_divergente/);
 }finally{rmSync(d,{recursive:true,force:true});}
 const src=readTextNormalized('scripts/kdp/ebook_bolso.py');
 assert.doesNotMatch(src,/requests|urllib|http\.client|amazon\.com|kdp\.amazon/,'nenhuma chamada de rede / publicação');
});
