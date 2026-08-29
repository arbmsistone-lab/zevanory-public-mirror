export const PROFESSIONAL_EMAIL = Object.freeze({
  primary:'contato@zevanory.api.br',
  aliases:Object.freeze(['suporte@zevanory.api.br','vendas@zevanory.api.br','financeiro@zevanory.api.br']),
  domain:'zevanory.api.br',
  requiredDns:Object.freeze(['MX','SPF','DKIM','DMARC']),
});

const link=(source)=>`https://zevanory.api.br/arbm-sist?utm_source=${source}&utm_medium=organic&utm_campaign=arbm_sist_launch`;

export const CHANNEL_PROFILES = Object.freeze({
  instagram:Object.freeze({handle:'@zevanory',url:link('instagram'),bio:'ARBM SIST | IA local-first para desenvolvimento com controle, testes e rollback. Demonstracoes reais e lancamento oficial.'}),
  facebook:Object.freeze({handle:'ZEVANORY',url:link('facebook'),bio:'Tecnologia aplicada com prova real. ARBM SIST: desenvolvimento assistido por IA, local-first, com testes, diff e rollback.'}),
  tiktok:Object.freeze({handle:'@zevanory',url:link('tiktok'),bio:'IA para desenvolvimento, com controle de engenharia. ARBM SIST, demos reais, local-first.'}),
  youtube:Object.freeze({handle:'ZEVANORY',url:link('youtube'),bio:'Demonstracoes tecnicas do ARBM SIST: IA local-first, worktrees, testes, diff, rollback e fluxos seguros.'}),
  linkedin:Object.freeze({handle:'ZEVANORY',url:link('linkedin'),bio:'Solucoes de software e automacao com foco em seguranca, controle operacional e evidencia tecnica.'}),
  google:Object.freeze({handle:'ZEVANORY',url:link('google'),bio:'ARBM SIST - agente de desenvolvimento com IA local-first, testes, worktrees, diff e rollback.'}),
  whatsapp:Object.freeze({handle:'ZEVANORY',url:link('whatsapp'),bio:'Atendimento e suporte oficial do ARBM SIST.'}),
  email:Object.freeze({handle:PROFESSIONAL_EMAIL.primary,url:link('email'),bio:'Canal oficial de contato, suporte e relacionamento da ZEVANORY.'}),
});
