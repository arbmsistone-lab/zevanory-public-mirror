const sessionId=crypto.randomUUID();
const params=new URLSearchParams(location.search);
const rawSource=(params.get('utm_source')||params.get('ref')||'zevanory').toLowerCase();
const source=rawSource.replace(/[^a-z0-9_-]/g,'').slice(0,40)||'zevanory';
async function track(name){
  const r=await fetch('/api/events/public',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({event_id:crypto.randomUUID(),name,session_id:sessionId,channel:source})});
  if(!r.ok) throw new Error(`telemetry_${r.status}`);
}
function money(v){return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
(async()=>{
  const cta=document.getElementById('cta'); const status=document.getElementById('status'); const state=document.getElementById('state');
  try{
    const r=await fetch('/api/config',{cache:'no-store'}); if(!r.ok) throw new Error('config'); const config=await r.json();
    const offer=config.offer||{}; const model=config.commercial_model||offer.commercial_model||{}; const pro=model.pro||{}; document.getElementById('price').textContent=money(pro.price_brl||offer.price_brl||config.experimental_price_brl);
    document.getElementById('hash').textContent=`SHA-256: ${offer.artifact_sha256||'indisponível'}`; try{await track('page_view')}catch{}
    const number=config.whatsapp_enabled?config.whatsapp_number:config.support_whatsapp_number;
    if(!number){cta.textContent='Contato temporariamente indisponível';status.textContent='Nenhum canal de contato público validado.';return;}
    cta.disabled=false;
    if(config.commercial_enabled&&config.whatsapp_enabled){
      state.textContent='OFERTA ATIVA'; cta.textContent='Comprar / falar no WhatsApp'; status.textContent='Canal comercial liberado pelos gates de produção.';
    }else{
      state.textContent='PRÉ-LANÇAMENTO'; cta.textContent='Entrar na lista de lançamento'; status.textContent='Venda e checkout continuam bloqueados. Este contato registra apenas interesse no lançamento.';
    }
    cta.onclick=async()=>{
      cta.disabled=true; try{await track('cta_whatsapp')}catch{}
      const intent=config.commercial_enabled?'Quero comprar o ARBM PRO e conhecer ZERO, Continuity, BOOST e BYOK.':'Quero entrar na lista de lançamento do ARBM SIST e conhecer ZERO, PRO, Continuity, BOOST e BYOK.';
      location.href=`https://wa.me/${number}?text=${encodeURIComponent(intent+' Origem: '+source)}`;
    };
  }catch{cta.textContent='Validação indisponível';status.textContent='Ação bloqueada porque a configuração segura não pôde ser validada.';}
})();
