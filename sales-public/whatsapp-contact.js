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
})();