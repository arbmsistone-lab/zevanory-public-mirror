import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {strictState,STATE_KEY,TRACK_PREFIX,encodeTrack} from '../../scripts/shorts-v2/music-kv.mjs';
export async function kvFixture(){
 const load=async f=>JSON.parse(await readFile(new URL('../../data/'+f,import.meta.url),'utf8')),manifest=await load('musica-licencas.json'),profile=await load('musica-perfil.json'),baseState=await load('musica-curadoria.json');
 const bytes=Buffer.concat([await readFile(new URL('../../assets/musica/ia-1.ogg',import.meta.url)),Buffer.from('test-fixture')]),row=structuredClone(manifest.faixas[0]);row.arquivo='assets/musica/cc0-fixture.ogg';row.titulo='Instrumental fixture';row.sha256=createHash('sha256').update(bytes).digest('hex');row.sha256_original=row.sha256;row.atributos.audio_sha256=row.sha256;row.tamanho_bytes=bytes.length;row.temas_permitidos=['ia','dicas'];
 const state=strictState(null,baseState);state.faixas[row.arquivo]={sha256:row.sha256,status:'observacao',videos:0,peso:2,desde:'2026-11-12',badWindows:0};state.catalogo[row.arquivo]=row;state.meses['2026-11']=[row.arquivo];
 const data=new Map([[STATE_KEY,JSON.stringify(state)],[TRACK_PREFIX+row.sha256,encodeTrack(bytes,row)]]),writes=[],deletes=[],kv={get:async k=>data.get(k)??null,put:async(k,v,opts)=>{writes.push({key:k,opts});data.set(k,v);},delete:async k=>{deletes.push(k);data.delete(k);}};
 return {kv,data,writes,deletes,state,manifest,profile,baseState,row,bytes};
}
