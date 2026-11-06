(()=>{
  // Contato público: a conta WhatsApp Business da ZEVANORY foi desativada permanentemente pela Meta
  // (2026-10-10) e o número está banido. O único endereço eletrônico oficial é o e-mail; este script
  // não injeta nenhum CTA de WhatsApp (data/politica-unica.json, contato_publico) e só troca o
  // endereço antigo pelo e-mail oficial.
  const EMAIL='suporte@zevanory.api.br';
  document.querySelectorAll('a[href^="mailto:contato@zevanory.api.br"]').forEach(a=>{a.href='mailto:'+EMAIL;});
})();