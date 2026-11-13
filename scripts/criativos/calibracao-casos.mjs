// Casos HOMOLOGADOS de calibração do Laboratório de Criativos (NC-R04): a mesma lista roda no teste de mídia (OCR real,
// parte determinística) e no workflow semanal (OCR real + oferta publicada + júri Gemini). Positivo: precisa ser
// APROVADO (objetivas OK e todas as notas >= 9,5). Negativos: precisam ser DESCARTADOS com os motivos esperados.
import {readFileSync,writeFileSync,readdirSync,copyFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
const FONTE=join(ROOT,'assets/fonts/Inter-ExtraBold.ttf');
const PINTAR="import sys;from PIL import Image,ImageDraw,ImageFont;im=Image.open(sys.argv[1]);ImageDraw.Draw(im).text((int(sys.argv[3]),int(sys.argv[4])),sys.argv[5],font=ImageFont.truetype(sys.argv[2],int(sys.argv[6])),fill=tuple(int(x) for x in sys.argv[7].split(',')));im.save(sys.argv[1])";
export const CASOS=Object.freeze([
 {nome:'positivo-v3-lcx',tipo:'positivo'},
 {nome:'negativo-preco-97',esperado:['preco_divergente','preco_oficial_ausente_no_video','valor_nao_conferido:R$97'],mutar:s=>{s.oferta.preco=97;}},
 {nome:'negativo-lucro-garantido',esperado:['promessa_proibida','lucro_fora_do_nome_do_produto'],mutar:s=>{s.oferta.beneficio='Lucro garantido em cada venda.';}},
 {nome:'negativo-numero-nao-calculado',esperado:['valor_nao_conferido:R$48'],mutar:s=>{s.numeros.margem_antes_fixas=48;}},
 {nome:'negativo-sem-planilha',esperado:['sem_prova_real_do_produto'],remover:'planilha'},
 {nome:'negativo-quadro-vazio',esperado:['quadro_vazio'],vazio:'venda'},
 {nome:'negativo-fora-da-area-segura',esperado:['conteudo_fora_da_area_segura'],pintar:['oferta',120,1640,'Oferta especial hoje',70,'255,255,255']},
 {nome:'negativo-texto-miudo',esperado:['texto_pequeno_demais'],pintar:['gancho',120,1300,'condições e detalhes importantes',18,'255,255,255']},
 {nome:'negativo-baixo-contraste',esperado:['texto_nao_reconhecido'],pintar:['gancho',120,1300,'condições especiais importantes',40,'45,55,70']},
 {nome:'negativo-v2-reprovado',esperado:['sem_prova_real_do_produto','preco_oficial_ausente_no_video','concordancia_genero','texto_artificial_ficticio'],v2:true}
]);
const py=a=>{const r=spawnSync('python3',['-I',...a],{encoding:'utf8',maxBuffer:64*1024*1024});if(r.status!==0)throw Error('calibracao_python:'+String(r.stderr).slice(-300));return r.stdout;};
export function spec(){return JSON.parse(readFileSync(join(ROOT,'data/shorts-v3/lcx.json'),'utf8'));}
export function prepararCaso(caso,dir){
 mkdirSync(dir,{recursive:true});const s=spec();
 if(caso.v2){const d=join(ROOT,'docs/criativos/calibracao/v2-reprovado'),c=JSON.parse(readFileSync(join(d,'criativo.json'),'utf8'));
  const quadros=readdirSync(d).filter(f=>f.endsWith('.png')).sort().map(f=>{const t=join(dir,f);copyFileSync(join(d,f),t);return t;});
  return {criativo:{sku:c.sku,falas:c.textos,oferta:{nome:'',preco:0}},quadros,provas:s.provas};}
 if(caso.mutar)caso.mutar(s);
 writeFileSync(join(dir,'spec.json'),JSON.stringify(s));
 const q=JSON.parse(py([join(ROOT,'scripts/shorts-v3/quadros.py'),ROOT,join(dir,'spec.json'),join(dir,'q')])).quadros;
 if(caso.remover)delete q[caso.remover];
 if(caso.vazio)py(['-c',"import sys;from PIL import Image;Image.new('RGB',(1080,1920),(9,13,20)).save(sys.argv[1])",q[caso.vazio]]);
 if(caso.pintar){const [qd,x,y,t,tam,cor]=caso.pintar;py(['-c',PINTAR,q[qd],FONTE,String(x),String(y),t,String(tam),cor]);}
 return {criativo:{sku:s.sku,falas:s.falas.map(f=>f.texto),oferta:{nome:s.oferta.nome,preco:s.oferta.preco}},quadros:Object.values(q).sort(),provas:s.provas};
}
export function medirCaso(prep,dir){
 writeFileSync(join(dir,'medir.json'),JSON.stringify({quadros:prep.quadros,provas:prep.provas.map(p=>({captura:join(ROOT,p.captura),largura:p.largura}))}));
 return JSON.parse(py([join(ROOT,'scripts/criativos/medir.py'),join(dir,'medir.json')]));
}
export function quadrosJuri(prep,dir){return prep.quadros.map((f,i)=>{const p=join(dir,`juri-${i}.png`);py(['-c',"import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').resize((540,960)).save(sys.argv[2])",f,p]);return readFileSync(p);});}
