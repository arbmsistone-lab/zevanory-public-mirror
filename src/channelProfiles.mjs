export const PROFESSIONAL_EMAIL = Object.freeze({
  primary:'contato@zevanory.api.br',
  aliases:Object.freeze(['suporte@zevanory.api.br','vendas@zevanory.api.br','financeiro@zevanory.api.br']),
  domain:'zevanory.api.br',
  requiredDns:Object.freeze(['MX','SPF','DKIM','DMARC']),
});

const brandLink=(source)=>`https://zevanory.api.br/?utm_source=${source}&utm_medium=organic&utm_campaign=zevanory_brand`;

export const CHANNEL_PROFILES = Object.freeze({
  instagram:Object.freeze({handle:'@zevanory_',profileUrl:'https://instagram.com/zevanory_',url:brandLink('instagram'),bio:'ZEVANORY | Tecnologia, automacao e solucoes digitais com operacao orientada por evidencia.'}),
  facebook:Object.freeze({handle:'ZEVANORY',url:brandLink('facebook'),bio:'Tecnologia, automacao, produtos e servicos digitais com foco em execucao segura e resultados reais.'}),
  tiktok:Object.freeze({handle:'@zevanory',url:brandLink('tiktok'),bio:'Tecnologia, automacao, produtos digitais e bastidores reais da ZEVANORY.'}),
  youtube:Object.freeze({handle:'@zevanory',profileUrl:'https://youtube.com/@zevanory',url:brandLink('youtube'),bio:'Canal oficial da ZEVANORY para produtos, servicos, demonstracoes e conteudo tecnico.'}),
  linkedin:Object.freeze({handle:'ZEVANORY',url:brandLink('linkedin'),bio:'Solucoes de software, automacao e operacoes digitais com foco em seguranca, controle e evidencia.'}),
  google:Object.freeze({handle:'ZEVANORY',url:brandLink('google'),bio:'ZEVANORY - tecnologia, automacao, produtos e servicos digitais.'}),
  whatsapp:Object.freeze({handle:'ZEVANORY',url:brandLink('whatsapp'),bio:'Atendimento oficial da ZEVANORY para produtos, servicos, vendas e suporte.'}),
  email:Object.freeze({handle:PROFESSIONAL_EMAIL.primary,url:brandLink('email'),bio:'Canal oficial de contato, suporte e relacionamento da ZEVANORY.'}),
});