// Laboratório de Criativos — AVALIADOR. A própria ZEVANORY decide APROVAR ou DESCARTAR cada criativo:
// 1) checagens objetivas (determinísticas): preço e nome oficiais, termos proibidos, gramática básica, legibilidade
//    e área segura medidas, prova real presente;
// 2) júri de IA (Gemini, nível gratuito) olhando os quadros do vídeo contra o PADRÃO NOTA 10 (base + observado).
// Aprova só com as duas camadas OK e TODAS as notas >= nota mínima. IA indisponível ou resposta inválida = DESCARTA
// (nunca aprova por falta de avaliação).
import {readFileSync} from 'node:fs';
import {CRITERIOS,NOTA_MINIMA,PROIBIDO,validarPadrao} from './padrao.mjs';
export function precosOficiais(src=readFileSync(new URL('../../worker/sales-public-worker.mjs',import.meta.url),'utf8')){
 const m=/const PRICES=(\{[^;]*\});/.exec(src);if(!m)throw Error('avaliador_catalogo_ausente');
 const t=JSON.parse(m[1]);for(const [sku,v] of Object.entries(t))if(!/^ZEV-[A-Z0-9]+-\d{3}$/.test(sku)||!Array.isArray(v)||typeof v[0]!=='string'||!Number.isInteger(v[1]))throw Error('avaliador_catalogo_invalido');
 return t;
}
const brl=n=>'R$ '+String(n);
// criativo: {sku, textos:[todas as frases que aparecem ou são faladas], oferta:{nome,preco}, medidas:{fonteMinPx,
// quadroVazioSeg, foraAreaSegura, provaReal}}
export function checagensObjetivas(criativo,precos=precosOficiais()){
 const motivos=[],oficial=precos[criativo?.sku];
 if(!oficial)return ['sku_fora_do_catalogo'];
 if(criativo.oferta?.nome!==oficial[0])motivos.push('nome_do_kit_divergente');
 if(criativo.oferta?.preco!==oficial[1])motivos.push('preco_divergente');
 const texto=(criativo.textos||[]).join('\n');
 for(const p of PROIBIDO)if(p.re.test(texto))motivos.push(p.motivo);
 for(const m of texto.matchAll(/R\$\s?(\d+(?:[.,]\d+)?)/g)){const v=Number(m[1].replace('.','').replace(',','.'));if(!Number.isFinite(v))motivos.push('valor_monetario_ilegivel');}
 if(!texto.includes(brl(oficial[1])))motivos.push('preco_oficial_ausente_no_video');
 const md=criativo.medidas||{};
 if(!(md.fonteMinPx>=32))motivos.push('texto_pequeno_demais');
 if(!(md.quadroVazioSeg===0))motivos.push('quadro_vazio');
 if(md.foraAreaSegura!==0)motivos.push('conteudo_fora_da_area_segura');
 if(md.provaReal!==true)motivos.push('sem_prova_real_do_produto');
 return motivos;
}
export function promptJuri(padrao){
 validarPadrao(padrao);
 const crit=CRITERIOS.map(c=>`- ${c.id}: ${c.pergunta}`).join('\n');
 const obs=padrao.observado.map(o=>`- (${o.criterio}) ${o.padrao}`).join('\n');
 return `Você é um diretor de criação exigente de YouTube Shorts focados em VENDA. As imagens são quadros, em ordem, de um Short vertical 1080x1920 (o áudio já foi aprovado). Dê nota de 0 a 10 (uma casa decimal) para cada critério. Nota 10 = padrão dos Shorts que mais performam; seja rigoroso: qualquer falha visível tira nota.\nCritérios:\n${crit}\nPadrões observados nos Shorts que mais performam (use como referência do nível 10):\n${obs}\nResponda só JSON: {"notas":{"gancho":n,"legibilidade":n,"prova":n,"oferta":n,"marca":n},"problemas":["..."],"melhorias":["..."]}`;
}
export function lerJuri(saida){
 if(!saida||typeof saida!=='object'||!saida.notas||typeof saida.notas!=='object')throw Error('juri_formato');
 const notas={};for(const c of CRITERIOS){const n=saida.notas[c.id];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>10)throw Error('juri_nota_invalida:'+c.id);notas[c.id]=Math.round(n*10)/10;}
 const lista=x=>Array.isArray(x)?x.filter(s=>typeof s==='string').map(s=>s.slice(0,240)).slice(0,10):[];
 return {notas,problemas:lista(saida.problemas),melhorias:lista(saida.melhorias)};
}
export function decidir({objetivas,juri,nota_minima=NOTA_MINIMA}){
 const geral=juri?Math.round(CRITERIOS.reduce((s,c)=>s+c.peso*juri.notas[c.id],0)*10)/10:null;
 const abaixo=juri?CRITERIOS.filter(c=>juri.notas[c.id]<nota_minima).map(c=>c.id+'='+juri.notas[c.id]):['juri_indisponivel'];
 const aprovado=objetivas.length===0&&abaixo.length===0;
 return {aprovado,decisao:aprovado?'APROVADO':'DESCARTADO',nota_geral:geral,motivos:[...objetivas,...abaixo.map(x=>'nota_abaixo:'+x)]};
}
const MODELOS=['gemini-3.8-flash','gemini-2.5-flash'];
export async function gerarJSON({key,partes,fetchImpl=fetch,modelos=MODELOS}){
 if(!key)throw Error('ia_chave_ausente');
 for(const model of modelos){
  const r=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},
   body:JSON.stringify({contents:[{role:'user',parts:partes}],generationConfig:{responseMimeType:'application/json',temperature:0.2}}),signal:AbortSignal.timeout(90000)}).catch(()=>null);
  if(!r||r.status!==200)continue;
  const j=await r.json().catch(()=>null),txt=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
  try{return {modelo:model,saida:JSON.parse(txt)};}catch{continue;}
 }
 throw Error('ia_indisponivel');
}
export async function avaliar({criativo,padrao,quadrosPng,key,fetchImpl=fetch,precos}){
 const objetivas=checagensObjetivas(criativo,precos);
 let juri=null,modelo=null,erro=null;
 try{const partes=[{text:promptJuri(padrao)},...quadrosPng.map(b=>({inline_data:{mime_type:'image/png',data:Buffer.from(b).toString('base64')}}))];
  const r=await gerarJSON({key,partes,fetchImpl});juri=lerJuri(r.saida);modelo=r.modelo;}catch(e){erro=String(e.message||e).slice(0,80);}
 return {...decidir({objetivas,juri,nota_minima:padrao.nota_minima}),juri,modelo,erro};
}
// Ciclo autônomo: cria -> avalia -> (refaz com os problemas apontados) no máximo 3 vezes. Sem aprovação na 3ª
// tentativa = BLOQUEIO com relatório (o Epaminondas recebe o motivo); nunca publica por cansaço nem tenta para sempre.
export const MAX_TENTATIVAS=3;
export async function cicloCriativo({gerar,avaliarCriativo,max=MAX_TENTATIVAS}){
 const historico=[];let feedback=null;
 for(let t=1;t<=max;t++){
  const criativo=await gerar({tentativa:t,feedback});
  const r=await avaliarCriativo(criativo);
  historico.push({tentativa:t,decisao:r.decisao,nota_geral:r.nota_geral??null,motivos:r.motivos.slice(0,12)});
  if(r.aprovado)return {estado:'APROVADO',tentativa:t,criativo,avaliacao:r,historico};
  feedback={motivos:r.motivos,problemas:r.juri?.problemas||[],melhorias:r.juri?.melhorias||[]};
 }
 const ultimo=historico.at(-1);
 return {estado:'BLOQUEADO',historico,relatorio:`Criativo bloqueado após ${max} tentativas. Última nota: ${ultimo?.nota_geral??'n/d'}. Motivos: ${(ultimo?.motivos||[]).join(', ')||'n/d'}.`};
}
