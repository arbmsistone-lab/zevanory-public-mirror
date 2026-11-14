// Laboratório de Criativos — AVALIADOR. A própria ZEVANORY decide APROVAR ou DESCARTAR cada criativo:
// 1) checagens objetivas (determinísticas): preço e nome oficiais, termos proibidos, gramática básica, legibilidade
//    e área segura medidas, prova real presente;
// 2) júri de IA (Gemini, nível gratuito) olhando os quadros do vídeo contra o PADRÃO NOTA 10 (base + observado).
// Aprova só com as duas camadas OK e TODAS as notas >= nota mínima. IA indisponível ou resposta inválida = DESCARTA
// (nunca aprova por falta de avaliação).
import {readFileSync} from 'node:fs';
import {CRITERIOS,NOTA_MINIMA,validarPadrao} from './padrao.mjs';
import {conferirAfirmacoes} from './afirmacoes.mjs';
export function precosOficiais(src=readFileSync(new URL('../../worker/sales-public-worker.mjs',import.meta.url),'utf8')){
 const m=/const PRICES=(\{[^;]*\});/.exec(src);if(!m)throw Error('avaliador_catalogo_ausente');
 const t=JSON.parse(m[1]);for(const [sku,v] of Object.entries(t))if(!/^ZEV-[A-Z0-9]+-\d{3}$/.test(sku)||!Array.isArray(v)||typeof v[0]!=='string'||!Number.isInteger(v[1]))throw Error('avaliador_catalogo_invalido');
 return t;
}
// NC-02/NC-03: nada declarado pelo criativo é aceito como medida. As medidas vêm de medir.py sobre o vídeo
// renderizado (origem obrigatória) e as afirmações são conferidas contra o conjunto calculado e a oferta publicada.
// criativo: {sku, falas:[texto falado], oferta:{nome,preco}}; medicao: saída de medir.py; permitidos: {reais,pct,outros};
// oficial: ofertaPublicada() (página de vendas no ar, com versão).
export const ALTURA_TEXTO_MIN_PX=18;
export function permitidosDe(numeros,preco){
 const n=numeros||{},pct=s=>Number(String(s).replace('%','').replace(',','.'));
 return {reais:[n.preco_venda,n.custo_produto_frete,n.taxa_cartao,n.margem_antes_fixas,n.preco_minimo,preco].filter(Number.isFinite),
  pct:[n.taxa_cartao_pct,pct(n.margem_pct),pct(n.desconto_maximo),n.meta_margem_pct].filter(Number.isFinite),outros:[7]};
}
// NC-R05: o conjunto permitido vem da PROVENIÊNCIA do cálculo (planilha real recalculada), não do roteiro.
export function permitidosDaProveniencia(P,preco){
 const E=P?.entradas,R=P?.resultados_calculados_pela_planilha;
 if(!E||!R||R.Status!=='OK')throw Error('proveniencia_invalida');
 const r1=v=>Math.round(v*1000)/10;
 return {reais:[E['Preço atual'],E['Custo direto unit.']+E['Outros custos var. unit.'],Math.round(E['Preço atual']*E['Taxa pagamento %']*100)/100,R['Contribuição/unit.'],R['Preço mínimo p/ margem alvo'],preco].filter(Number.isFinite),
  pct:[r1(E['Taxa pagamento %']),r1(R['Margem contribuição %']),r1(R['Desconto máx. p/ margem alvo']),r1(P.margem_alvo_config)].filter(Number.isFinite),outros:[7]};
}
export function checagensObjetivas({criativo,medicao,permitidos,oficial},precos=precosOficiais()){
 const motivos=[],cat=precos[criativo?.sku];
 if(!cat)return ['sku_fora_do_catalogo'];
 if(criativo.oferta?.nome!==cat[0])motivos.push('nome_do_kit_divergente');
 if(criativo.oferta?.preco!==cat[1])motivos.push('preco_divergente');
 if(!oficial||!Number.isFinite(oficial.preco)||typeof oficial.versao!=='string')motivos.push('oferta_publicada_nao_conferida');
 else if(oficial.preco!==cat[1])motivos.push('oferta_publicada_divergente');
 const md=medicao?.medidas;
 if(!md||md.origem!=='medicao_independente_ocr'||!Array.isArray(medicao.quadros)||!medicao.quadros.length)return [...motivos,'medicao_independente_ausente'];
 const telas=medicao.quadros.map(q=>String(q.texto||''));
 if(!telas.some(t=>new RegExp('R\\$\\s?'+cat[1]+'(?![\\d,])').test(t)))motivos.push('preco_oficial_ausente_no_video');
 if(!(md.alturaTextoMinPx>=ALTURA_TEXTO_MIN_PX))motivos.push('texto_pequeno_demais');
 if(md.quadrosVazios!==0)motivos.push('quadro_vazio');
 if(md.foraAreaSegura!==0)motivos.push('conteudo_fora_da_area_segura');
 if(md.provaReal!==true)motivos.push('sem_prova_real_do_produto');
 if(md.textoNaoReconhecido!==0)motivos.push('texto_nao_reconhecido');
 motivos.push(...conferirAfirmacoes({falas:criativo.falas||[],telas,permitidos:permitidos||{reais:[],pct:[]}}));
 return motivos;
}
export function promptJuri(padrao){
 validarPadrao(padrao);
 const crit=CRITERIOS.map(c=>`- ${c.id}: ${c.pergunta}`).join('\n');
 const obs=padrao.observado.length?padrao.observado.map(o=>`- ${o.padrao} (${o.evidencias.length} Shorts reais)`).join('\n'):'- (sem pesquisa disponível nesta execução)';
 return `Você é um diretor de criação exigente de YouTube Shorts focados em VENDA. As imagens são quadros, em ordem, de um Short vertical 1080x1920 (o áudio já foi aprovado). Dê nota de 0 a 10 (uma casa decimal) para cada critério. Nota 10 = padrão dos Shorts que mais performam; seja rigoroso: qualquer falha visível tira nota. Em vídeos verticais de 1080 × 1920, considere que a faixa abaixo de y=1470 e a região à direita de x=940 podem ser ocupadas por elementos da interface do YouTube Shorts. Avalie a composição, a legibilidade e o aproveitamento da área útil restante com o mesmo rigor. Espaços vazios injustificados dentro da área útil continuam sendo defeitos de composição.\nCritérios:\n${crit}\nFatos medidos nos metadados dos Shorts que mais performam (apenas contexto; não descrevem o visual):\n${obs}\nResponda só JSON: {"notas":{"gancho":n,"legibilidade":n,"prova":n,"oferta":n,"marca":n},"problemas":["..."],"melhorias":["..."]}`;
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
// Ordem de preferência; modelo inexistente (404) é pulado e registrado no diagnóstico.
const MODELOS=['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-2.5-flash'];
// Laboratório real 43594274773 cancelado no limite de 30 min: cada um dos 10 casos voltava a testar os modelos que já
// tinham falhado (404/403 ou 429 após a espera), gastando ~2 min por caso. Agora um modelo que falhou de forma
// definitiva nesta execução é pulado nas chamadas seguintes (memória só do processo; nada persiste nem libera nada).
export const modelosFora=new Set();
export async function gerarJSON({key,partes,fetchImpl=fetch,modelos=MODELOS,esperar=ms=>new Promise(r=>setTimeout(r,ms)),esperaMs=35000,fora=modelosFora}){
 if(!key)throw Error('ia_chave_ausente');
 const diag=[];// só modelo, HTTP e o status de erro do Google (ex.: RESOURCE_EXHAUSTED); nunca chave nem conteúdo
 for(const model of modelos){if(fora.has(model)){diag.push(`${model}=pulado`);continue;}for(let tentativa=0;tentativa<2;tentativa++){
  if(tentativa)await esperar(esperaMs);// 429/503 do nível gratuito: espera e tenta 1 vez no mesmo modelo
  const r=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,{method:'POST',headers:{'x-goog-api-key':key,'content-type':'application/json'},
   body:JSON.stringify({contents:[{role:'user',parts:partes}],generationConfig:{responseMimeType:'application/json',temperature:0.2}}),signal:AbortSignal.timeout(90000)}).catch(e=>({erroRede:String(e?.name||'erro')}));
  if(r?.erroRede){diag.push(`${model}=rede_${r.erroRede}`);break;}
  if(!r||r.status!==200){const j=await r?.json?.().catch(()=>null);diag.push(`${model}=${r?.status??'sem_resposta'}${/^[A-Z_]{3,40}$/.test(j?.error?.status||'')?'_'+j.error.status:''}`);if((r?.status===429||r?.status===503)&&!tentativa)continue;if(r?.status!==503)fora.add(model);break;}
  const j=await r.json().catch(()=>null),txt=j?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');
  try{return {modelo:model,saida:JSON.parse(txt)};}catch{diag.push(`${model}=json_invalido`);break;}
 }}
 throw Error('ia_indisponivel:'+diag.join(','));
}
export async function avaliar({criativo,padrao,quadrosPng,medicao,permitidos,oficial,key,fetchImpl=fetch,precos,esperar}){
 const objetivas=checagensObjetivas({criativo,medicao,permitidos,oficial},precos);
 let juri=null,modelo=null,erro=null;
 try{const partes=[{text:promptJuri(padrao)},...quadrosPng.map(b=>({inline_data:{mime_type:'image/png',data:Buffer.from(b).toString('base64')}}))];
  const r=await gerarJSON({key,partes,fetchImpl,...(esperar?{esperar}:{})});juri=lerJuri(r.saida);modelo=r.modelo;}catch(e){erro=String(e.message||e).slice(0,200);}
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
// NC-06/NC-R03: decisão persistida, ASSINADA (HMAC-SHA256 com a chave CRIATIVOS_DECISAO_KEY, que só existe nos
// ambientes do laboratório/publicação) e exigida no caminho real de upload (publishShort). Sem chave, a decisão sai
// sem assinatura e NUNCA publica. Arquivo diferente, registro alterado/forjado, reprovado, vencido = BLOQUEIO.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
const sha256=b=>createHash('sha256').update(b).digest('hex');
const canonico=v=>Array.isArray(v)?'['+v.map(canonico).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).filter(k=>k!=='assinatura').sort().map(k=>JSON.stringify(k)+':'+canonico(v[k])).join(',')+'}':JSON.stringify(v);
const hmac=(d,chave)=>'hmac-sha256:'+createHmac('sha256',chave).update(canonico(d)).digest('hex');
const chaveValida=c=>typeof c==='string'&&c.length>=32;
export function registrarDecisao({videoBytes,sku,avaliacao,padrao,commit,oficial,chave=null,em=new Date().toISOString()}){
 const d={schema:2,sha256_video:sha256(videoBytes),sku,decisao:avaliacao.aprovado===true?'APROVADO':'DESCARTADO',aprovado:avaliacao.aprovado===true,
  nota_geral:avaliacao.nota_geral??null,notas:avaliacao.juri?.notas||null,motivos:avaliacao.motivos||[],padrao_gerado_em:padrao?.geradoEm||null,
  commit:commit||null,oferta_publicada:oficial||null,em};
 return {...d,assinatura:chaveValida(chave)?hmac(d,chave):null};
}
export function exigirAprovacao(decisao,videoBytes,{chave,now=Date.now(),maxIdadeH=48}={}){
 if(!chaveValida(chave))throw Error('publicacao_bloqueada:chave_de_decisao_ausente');
 if(!decisao||typeof decisao!=='object'||decisao.schema!==2)throw Error('publicacao_bloqueada:decisao_ausente');
 const esperado=Buffer.from(hmac(decisao,chave)),dada=Buffer.from(String(decisao.assinatura||''));
 if(dada.length!==esperado.length||!timingSafeEqual(dada,esperado))throw Error('publicacao_bloqueada:assinatura_invalida');
 if(!Buffer.isBuffer(videoBytes)&&!(videoBytes instanceof Uint8Array))throw Error('publicacao_bloqueada:video_ausente');
 if(decisao.sha256_video!==sha256(videoBytes))throw Error('publicacao_bloqueada:video_diferente_do_avaliado');
 if(decisao.decisao!=='APROVADO'||decisao.aprovado!==true)throw Error('publicacao_bloqueada:criativo_reprovado');
 const t=Date.parse(decisao.em);if(!Number.isFinite(t)||now-t>maxIdadeH*3600000||t>now+300000)throw Error('publicacao_bloqueada:decisao_vencida');
 const n=decisao.notas;if(!n||CRITERIOS.some(c=>!(n[c.id]>=NOTA_MINIMA)))throw Error('publicacao_bloqueada:notas_insuficientes');
 return true;
}
