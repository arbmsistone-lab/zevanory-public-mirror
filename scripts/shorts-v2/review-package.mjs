// Build a portable review artifact outside the checkout. No credentials or publish path.
import {mkdir,readFile,writeFile,copyFile,readdir,stat} from 'node:fs/promises';
import {artifactOutside} from './delivery-policy.mjs';
import {createHash} from 'node:crypto';
import {resolve,relative,basename,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const html=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

const page=(title,body)=>`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(title)}</title></head><body><h1>${html(title)}</h1><p>Prévia técnica offline, com tom sintético de teste. Não é a voz aprovada. Nenhuma publicação ou escolha está autorizada.</p>${body}</body></html>\n`;
export async function reviewPackage(output,previews){
 artifactOutside(output,root);artifactOutside(previews,root);await mkdir(join(output,'musicas'),{recursive:true});
 const manifest=JSON.parse(await readFile(join(root,'data/musica-licencas.json'),'utf8'));
 const music=[];
 for(const track of manifest.faixas){
  const src=join(root,track.arquivo),bytes=await readFile(src);if(createHash('sha256').update(bytes).digest('hex')!==track.sha256)throw Error('review_music_hash_mismatch');
  const file='musicas/'+basename(track.arquivo);await copyFile(src,join(output,file));
  music.push(`<section><h2>${html(basename(track.arquivo,'\.ogg'))} — ${html(track.titulo)}</h2><p>${html(track.autor)} · ${html(track.temas_permitidos.join(', '))}</p><audio controls preload="none" src="${html(file)}"></audio><p><a href="${html(track.pagina_licenca)}">Licença</a></p><p>SHA-256: ${track.sha256}</p></section>`);
 }
 if(music.length<2)throw Error('review_requires_alternate_tracks');
 await writeFile(join(output,'musicas.html'),page('Músicas aprovadas para avaliação',music.join('\n')));
 await writeFile(join(output,'licencas.json'),JSON.stringify(manifest,null,2)+'\n');
 await copyFile(join(previews,'simulacao-180-dias.json'),join(output,'simulacao-180-dias.json'));
 const cards=[];
 for(const stem of ['2026-11-12-dica','2026-11-13-calc','2026-11-14-oferta']){
  const qc=JSON.parse(await readFile(join(previews,stem+'-qc.json'),'utf8'));if(qc.ok!==true)throw Error('review_preview_qc_failed');
  for(const ext of ['.mp4','-contato.png','-legendas.ass','-qc.json','-roteiro.txt','-scenes.json']){if(!(await stat(join(previews,stem+ext))).size)throw Error('review_preview_missing');await copyFile(join(previews,stem+ext),join(output,stem+ext));}
  cards.push(`<section><h2>${stem}</h2><video controls preload="metadata" width="270" src="${stem}.mp4"></video><p><a href="${stem}-contato.png">Quadros</a> · <a href="${stem}-qc.json">Medições</a> · <a href="${stem}-roteiro.txt">Roteiro</a></p></section>`);
 }
 await writeFile(join(output,'previews.html'),page('Previews técnicos',cards.join('\n')+'<p><a href="musicas.html">Músicas</a></p>'));
 const hashes={};for(const name of (await readdir(output,{recursive:true})).sort()){const path=join(output,name);if((await stat(path)).isFile())hashes[name]=createHash('sha256').update(await readFile(path)).digest('hex');}
 await writeFile(join(output,'hashes.json'),JSON.stringify(hashes,null,2)+'\n');
 return {tracks:music.length,previews:cards.length,files:Object.keys(hashes).length};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2]||!process.argv[3])throw Error('usage_review_package_output_preview_directory');
 console.log(JSON.stringify(await reviewPackage(resolve(process.argv[2]),resolve(process.argv[3]))));
}
