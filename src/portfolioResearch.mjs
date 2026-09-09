import { collectMarketSignals, aggregateMarketSignals } from './marketResearchFabric.mjs';
import { evaluatePrelaunchInvestment, rankPrelaunchPortfolio } from './prelaunchInvestment.mjs';

const clean=(v,max=180)=>String(v||'').trim().slice(0,max);

async function mapLimit(items,limit,worker){
  const out=new Array(items.length);let next=0;
  async function run(){while(true){const i=next++;if(i>=items.length)return;out[i]=await worker(items[i],i);}}
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length||1))},()=>run()));return out;
}

export async function researchPortfolio(products=[],options={}){
  const concurrency=Math.max(1,Math.min(4,Number(options.concurrency)||2));
  const rows=await mapLimit(Array.isArray(products)?products:[],concurrency,async product=>{
    const subject=clean(product.market_query||product.product||product.name||product.sku);
    const collected=await collectMarketSignals(subject,options);
    const aggregate=aggregateMarketSignals(subject,collected);
    return Object.freeze({subject,aggregate,evaluation:evaluatePrelaunchInvestment({product,marketInput:aggregate.input,economics:options.economicsBySku?.[product.sku]||{}})});
  });
  return Object.freeze({generated_at:new Date().toISOString(),total:rows.length,concurrency,ranking:rankPrelaunchPortfolio(rows.map(x=>x.evaluation)),rows:Object.freeze(rows)});
}