// Laboratório de Criativos — AFIRMAÇÕES FINANCEIRAS E COMERCIAIS (NC-03). Todo valor em R$ ou % que aparece na tela
// (lido por OCR do vídeo renderizado) ou que é falado precisa pertencer ao conjunto CALCULADO (planilha real com
// proveniência) ou ao preço oficial publicado. Valor desconhecido reprova. "Lucro" só no nome do produto.
const UN={zero:0,um:1,uma:1,dois:2,duas:2,'três':3,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12,treze:13,quatorze:14,catorze:14,quinze:15,dezesseis:16,dezessete:17,dezoito:18,dezenove:19,
 vinte:20,trinta:30,quarenta:40,cinquenta:50,sessenta:60,setenta:70,oitenta:80,noventa:90,cem:100,cento:100,duzentos:200,duzentas:200,trezentos:300,quatrocentos:400,quinhentos:500,seiscentos:600,setecentos:700,oitocentos:800,novecentos:900};
const norm=s=>String(s).toLowerCase().normalize('NFC').replace(/[.,:;!?()]/g,' ').split(/\s+/).filter(Boolean);
// Números por extenso na fala. "um/uma" isolado antes de substantivo é artigo, não número.
export function valoresFalados(texto){
 const w=norm(texto),out=[];let i=0;
 while(i<w.length){
  if((!(w[i] in UN)&&w[i]!=='mil')||((w[i]==='um'||w[i]==='uma')&&!(w[i+1]==='vírgula'||w[i+1]==='por'||w[i+1]==='real'||w[i+1]==='mil'))){i++;continue;}
  let v=0,cur=0,j=i;
  while(j<w.length){if(w[j] in UN){cur+=UN[w[j]];j++;}else if(w[j]==='mil'){cur=(cur||1)*1000;v+=cur;cur=0;j++;}else if(w[j]==='e'&&(w[j+1] in UN)){j++;}else break;}
  v+=cur;let dec=null;
  if(w[j]==='vírgula'||w[j]==='virgula'){let d=0,k=j+1,ok=false;while(k<w.length&&(w[k] in UN)){d+=UN[w[k]];k++;ok=true;if(w[k]==='e'&&(w[k+1] in UN))k++;}if(ok){dec=d;j=k;}}
  const unidade=w[j]==='por'&&w[j+1]==='cento'?'%':(w[j]==='reais'||w[j]==='real')?'R$':(w[j]==='dias'||w[j]==='dia')?'dias':null;
  out.push({valor:dec===null?v:Number(v+'.'+dec),unidade});i=j+(unidade==='%'?2:unidade?1:0);
 }
 return out;
}
const num=s=>Number(String(s).replace(/\./g,'').replace(',','.'));
export function valoresNaTela(texto){
 const t=String(texto),out=[];
 for(const m of t.matchAll(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/g))out.push({valor:num(m[1]),unidade:'R$'});
 for(const m of t.matchAll(/(\d+(?:,\d+)?)\s?%/g))out.push({valor:num(m[1]),unidade:'%'});
 return out;
}
import {bannedPolicyHits} from '../../worker/politica-unica.mjs';
const PROMESSA=/\b(garantido|garantida|garantimos|fique rico|renda extra|enriquecer|lucro certo|sem risco)\b/i;
export function conferirAfirmacoes({falas,telas,permitidos}){
 const motivos=new Set(),okR=new Set(permitidos.reais),okP=new Set(permitidos.pct),okN=new Set(permitidos.outros||[]);
 const tudo=[...falas,...telas].join('\n');
 if(PROMESSA.test(tudo))motivos.add('promessa_proibida');
 // Política única (P13c): redação de prazo/garantia/entrega só nas formas aprovadas.
 for(const h of bannedPolicyHits(tudo))motivos.add('politica_formulacao_divergente:'+String(h).slice(0,40));
 for(const m of tudo.matchAll(/\blucro\b/gi)){const depois=tudo.slice(m.index+m[0].length,m.index+m[0].length+10);if(!/^\s*(&|e)?\s*caixa/i.test(depois))motivos.add('lucro_fora_do_nome_do_produto');}
 for(const f of falas)if(/\b(um|uns)\s+(reserva|venda|entrega|agenda|proposta|margem|taxa)\b/i.test(f))motivos.add('concordancia_genero');
 if(/\bfict[ií]ci[oa]s?\b/i.test(tudo))motivos.add('texto_artificial_ficticio');
 for(const v of telas.flatMap(valoresNaTela)){if(v.unidade==='R$'&&!okR.has(v.valor))motivos.add('valor_nao_conferido:R$'+v.valor);if(v.unidade==='%'&&!okP.has(v.valor))motivos.add('valor_nao_conferido:'+v.valor+'%');}
 for(const v of falas.flatMap(valoresFalados)){if(v.unidade==='%'?!okP.has(v.valor):v.unidade==='dias'?!okN.has(v.valor):!(okR.has(v.valor)||okN.has(v.valor)))motivos.add('valor_falado_nao_conferido:'+v.valor+(v.unidade||''));}
 return [...motivos];
}
// Oferta oficial publicada: preço lido da página de vendas no ar, com registro da fonte e da versão (hash).
export async function ofertaPublicada(slug,fetchImpl=fetch){
 const url='https://vendas.zevanory.api.br/'+slug;
 const r=await fetchImpl(url,{headers:{'user-agent':'Mozilla/5.0 zevanory-criativos','accept-language':'pt-BR'},signal:AbortSignal.timeout(20000)}).catch(()=>null);
 if(!r||r.status!==200)throw Error('oferta_publicada_ilegivel');
 const html=await r.text(),m=/Comprar agora\s*·\s*R\$\s*(\d+)/.exec(html)||/Total<\/[^>]+>\s*<[^>]+>\s*R\$\s*(\d+)/.exec(html);
 if(!m)throw Error('oferta_publicada_sem_preco');
 const {createHash}=await import('node:crypto');
 return {fonte:url,preco:Number(m[1]),versao:'sha256:'+createHash('sha256').update(html).digest('hex').slice(0,16),lido_em:new Date().toISOString()};
}
