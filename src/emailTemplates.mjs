const BRAND='ZEVANORY';
const PRODUCT='ARBM SIST 8.1.0';
const SITE='https://zevanory.api.br/arbm-sist?utm_source=email';
export const EMAIL_IDENTITIES=Object.freeze({
  from:'ZEVANORY <contato@zevanory.api.br>',
  support:'suporte@zevanory.api.br',
  sales:'vendas@zevanory.api.br',
  finance:'financeiro@zevanory.api.br',
});
const safe=(v,max=120)=>String(v||'').replace(/[\r\n<>]/g,' ').trim().slice(0,max);
export function launchWelcome(name=''){
  const hello=safe(name)?`Ola, ${safe(name)}.`:'Ola.';
  return Object.freeze({subject:`Lista de lancamento | ${PRODUCT}`,text:`${hello}\n\nSeu interesse no ${PRODUCT} foi registrado. A ZEVANORY usa demonstracoes reais e nao promete resultados inventados.\n\nDetalhes: ${SITE}\n\nSuporte: ${EMAIL_IDENTITIES.support}`});
}
export function checkoutStarted(){
  return Object.freeze({subject:`Checkout iniciado | ${PRODUCT}`,text:`Voce iniciou o checkout do ${PRODUCT}. Nenhum acesso e liberado antes da confirmacao real do pagamento.\n\nSe precisar de ajuda: ${EMAIL_IDENTITIES.sales}`});
}
export function paymentConfirmed(secureDeliveryUrl){
  const url=safe(secureDeliveryUrl,500);
  if(!/^https:\/\//.test(url)) throw new Error('secure_delivery_url_required');
  return Object.freeze({subject:`Pagamento confirmado | ${PRODUCT}`,text:`Pagamento confirmado. Seu acesso seguro ao ${PRODUCT}: ${url}\n\nNao compartilhe este link. Suporte: ${EMAIL_IDENTITIES.support}`});
}
export function supportAcknowledgement(ticketId){
  const id=safe(ticketId,64); if(!id) throw new Error('ticket_id_required');
  return Object.freeze({subject:`Suporte ZEVANORY | ${id}`,text:`Recebemos sua solicitacao ${id}. A equipe respondera pelo canal oficial de suporte.\n\n${BRAND} | ${EMAIL_IDENTITIES.support}`});
}