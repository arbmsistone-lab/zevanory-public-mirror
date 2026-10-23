(()=>{
  // ENABLED vem de data/politica-unica.json (contato_publico.whatsapp_public_links_enabled): o build
  // (scripts/build_sales_public.py) troca para true só com o número operacional. Com false, nenhum
  // CTA de WhatsApp é injetado e o contato antigo vira o e-mail que funciona.
  const ENABLED=false;
  const EMAIL='suporte@zevanory.api.br';
  if(!ENABLED){
    document.querySelectorAll('a[href^="mailto:contato@zevanory.api.br"]').forEach(a=>{a.href='mailto:'+EMAIL;});
    return;
  }
  /*whatsapp:start (o build remove este bloco com whatsapp_public_links_enabled=false)*/
  const NUMBER='5588992545413';
  const text='Olá! Tenho interesse nas soluções da ZEVANORY e gostaria de receber uma orientação personalizada.';
  const href=`https://wa.me/${NUMBER}?text=${encodeURIComponent(text)}`;
  const make=(cls,label)=>{const a=document.createElement('a');a.className=cls;a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.dataset.whatsappOfficial='true';a.textContent=label;return a;};

  document.querySelectorAll('a[href^="mailto:contato@zevanory.api.br"]').forEach(a=>{
    if(/falar|contato|atendimento|avaliar/i.test(a.textContent||'')){
      a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.dataset.whatsappOfficial='true';a.textContent='Falar no WhatsApp';
    }
  });

  const header=document.querySelector('.site-header nav,.header-state');
  if(header&&!header.querySelector('[data-whatsapp-official]')&&!header.querySelector('a[href*="wa.me/"]'))header.appendChild(make('whatsapp-header-cta','WhatsApp'));

  const actions=document.querySelector('.hero .actions,.hero-actions');
  if(actions&&!actions.querySelector('[data-whatsapp-official]')&&!actions.querySelector('a[href*="wa.me/"]'))actions.appendChild(make('secondary whatsapp-hero-cta','Falar no WhatsApp'));

  const footer=document.querySelector('footer');
  if(footer&&!footer.querySelector('[data-whatsapp-official]')&&!footer.querySelector('a[href*="wa.me/"]')){
    const target=footer.querySelector('.footer-nav,nav')||footer;
    target.appendChild(make('whatsapp-footer-link','WhatsApp'));
  }
  /*whatsapp:end*/
})();