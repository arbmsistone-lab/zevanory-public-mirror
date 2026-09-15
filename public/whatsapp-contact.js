(()=>{
  const NUMBER='558892340423',DISPLAY='+55 88 9234-0423';
  const text='Olá! Tenho interesse nas soluções da ZEVANORY e gostaria de receber uma orientação personalizada.';
  const href=`https://wa.me/${NUMBER}?text=${encodeURIComponent(text)}`;
  const make=(cls,label)=>{const a=document.createElement('a');a.className=cls;a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.dataset.whatsappOfficial='true';a.textContent=label;return a;};
  const header=document.querySelector('.site-header nav,.header-state');
  if(header&&!header.querySelector('[data-whatsapp-official]'))header.appendChild(make('whatsapp-header-cta','WhatsApp'));
  const footer=document.querySelector('footer');
  if(footer&&!footer.querySelector('[data-whatsapp-official]')){const wrap=document.createElement('span');wrap.className='whatsapp-footer-contact';wrap.append('Atendimento: ',make('whatsapp-footer-link',`WhatsApp ${DISPLAY}`));footer.appendChild(wrap);}
  const actions=document.querySelector('.hero .actions');
  if(actions&&!actions.querySelector('[data-whatsapp-official]'))actions.appendChild(make('secondary whatsapp-hero-cta','Falar no WhatsApp'));
  document.querySelectorAll('a[href^="mailto:contato@zevanory.api.br"]').forEach(a=>{if(/falar|contato|atendimento/i.test(a.textContent||'')){a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.dataset.whatsappOfficial='true';a.textContent='Falar no WhatsApp';}});
})();
