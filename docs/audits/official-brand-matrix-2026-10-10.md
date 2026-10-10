# ZEVANORY | auditoria final do padrão oficial
**Data:** 2026-10-10 · **Natureza:** fiscalização de código + evidência disponível; NÃO equivale a prova de perfis externos atualizados.
**Referências:** gh-pages 9371c594451cc3a252f27d5656e9afdb859fe3b1; kit #629 (merge); follow-up #630 (não integrado); marca/SEO/e-mails #633 (este PR); painel control-edge #179 (integrado em fe5481c, deploy canônico bloqueado).

**Identidade obrigatória:** ZEVANORY; símbolo Z derivado de `sales-public/brand/zevanory-mark.svg`; avatar `assets/brand/export/avatar-800.png`; banners por plataforma; slogan "Menos improviso. Mais execução."; vitrine vendas.zevanory.api.br. Bio: IA na prática para pequenos negócios; criada por Renan Bitu, Várzea Alegre/CE; UTM correspondente.
**Identidade jurídica:** A. RENAN ALVES MOREIRA BITU LTDA, CNPJ 69.077.233/0001-99, Rua Francisco de Freitas Neto, 96, Casa Residencial, Alto do Tenente, Várzea Alegre/CE, CEP 63540-000, suporte@zevanory.api.br, WhatsApp +55 88 99254-5413.
**Catálogo travado:** ZEV-IA-011 R$197; ZEV-VEN-011 R$197; ZEV-LCX-011 R$247; ZEV-CMB-011 R$297; ZEV-NGC-011 R$397.

| Frente | Item | CONFORME? | Prova | Correção |
|---|---|---|---|---|
| Vitrine | Cinco preços, cinco SKUs, dados jurídicos | CONFORME no código | `worker/sales-public-worker.mjs`, `worker/support-knowledge.mjs`, `sales-public/{ia-na-pratica,vendas-na-pratica,lucro-e-caixa,combo-ia-vendas,negocio-completo}.html` | Não alterar preços |
| Vitrine | Quem criou: favicon, logo, contatos, rodapé | NÃO CONFORME em produção | `quem-criou/index.html` no base SHA | Corrigido neste PR; aguarda deploy |
| Vitrine | OG imagens e iconografia funcional no site real | NÃO CONFORME (não comprovado) | #629; deploy 38068566936 falhou em avatar-400.png, rollback | Gate estático #630, aguarda checks/deploy |
| Vitrine | Termos, privacidade, reembolso | CONFORME no texto jurídico | `sales-public/{termos,privacidade,reembolso}.html` | Sem modificação de política |
| Mercado Pago | Título/valor/descrição, recebedor visível | NÃO CONFORME (sem readback da preferência) | Código valida cinco SKUs, mas nenhuma preferência real foi consultada | Auditoria GET-only de preferência autorizada, sem POST financeiro |
| WhatsApp | Respostas, preços, link/UTM | CONFORME na proteção de código | `worker/whatsapp-conversation.mjs` | Sem alterar motor |
| WhatsApp | Nome e foto do perfil comercial reais | NÃO CONFORME (sem readback) | Sem API/permissões confirmadas | Depende do dono: WhatsApp Business > Ferramentas comerciais > Perfil comercial |
| E-mails | Resend domínio/remetente e entrega de teste | CONFORME parcialmente, NÃO CONFORME como padrão visual | Resend domínio zevanory.api.br verificado; testes enviados em texto simples | HTML com arte Z e rodapé via `worker/brand-email.mjs`; aguardando deploy/prova |
| Telegram | Post existente | CONFORME apenas quanto ao recibo | Run 38068289546 mostrou t.me/zevanory/6 (2026-10-10) | Falta prova de imagem e revisão do conteúdo publicado |
| Telegram | Nome/foto/descrição | NÃO CONFORME (sem readback) | `worker/brand-profiles.mjs`; sem recibo real | Neste PR: título, bio e readback; foto protegida por SHA, exige permissões do bot |
| Telegram | Posts futuros com Z | NÃO CONFORME em produção | Aquisição antes enviava só texto | Neste PR aquisição com `post-01.png`; motor legado ainda necessita auditoria |
| Bluesky | Nome, Z, capa, bio e posts com imagem | NÃO CONFORME (sem readback) | `worker/brand-profiles.mjs`, `worker/bluesky-publisher.mjs` | Neste PR nome e bio; capa/avatar do #629; falta prova de post com imagem real |
| Blog | Título, CTA, UTM | CONFORME no código | `worker/multichannel-autonomy.mjs` | Mantidos |
| Blog | Imagem Z, autoria, SEO e rodapé | NÃO CONFORME em produção | Renderer base não tinha imagem/autor | Neste PR usa `blog-card.png`, autoria, OG e rodapé |
| Pinterest | Imagem de publicação dinâmica com Z | NÃO CONFORME até deploy | #630 acrescenta imagem oficial hash-pinned | Aguardando #630 e prova de post |
| YouTube | Avatar, banner, bio, Shorts | NÃO CONFORME (sem readback) | `assets/brand/export/banner-youtube.png` | Depende do dono em studio.youtube.com |
| Instagram | Avatar, bio e posts | NÃO CONFORME (sem readback) | `assets/brand/README.md` | Depende do dono e revisão Meta |
| Facebook | Avatar, capa, bio e posts | NÃO CONFORME (sem readback) | `assets/brand/export/banner-facebook.png` | Depende do dono e revisão Meta |
| Painel | Nome, logo, favicon | NÃO CONFORME em produção (código corrigido) | control-edge PR #179, merge fe5481c, 6/6 checks PR verdes; deploy run 38070097812 falhou | Control Center usando logo/favicons oficiais; deploy Cloudflare exige secret autenticado |
| Painel | Timeline de profile_updated e post_published | NÃO CONFORME (UI/readback não comprovados) | `worker/activity-ledger.mjs`; `/api/admin/brand/snapshot` apenas se PIN | Provar UI/readback sem PII |
| Google | Sitemap com host canônico da loja | NÃO CONFORME em produção | `sales-public/sitemap.xml` apontava para apex | Neste PR separa sitemap da loja dos artigos do apex |
| Google | Resultado indexado/Business Profile | NÃO CONFORME (sem acesso/readback) | Search Console/Business profile não conectados | Depende do dono para revisão e indexação |

**PENDÊNCIAS BLOQUEANTES:**
1. Deploy central do #629 teve `BRAND_LIVE_ASSET_UNVERIFIED avatar-400.png` após SHA exato; houve rollback automático. #630 contém possível reparo `ASSETS.fetch`, ainda não homologado.
2. ZEES-16/provider-independence e qualidade remota de #630/#632 falharam, com divergência entre status comercial globalmente bloqueado e `/api/sales/status` abrindo; não alterar gates para conseguir merge.
3. Atualização de perfis só recebe `profile_updated` após confirmação do provedor e readback. Nenhum perfil atualizado foi provado nesta auditoria.
4. Log/print do checkout de Mercado Pago e prova dos emails finais precisam de readback com autorização, apenas GET/read-only, sem compras reais.
5. Meta/Google/YouTube e foto WhatsApp podem exigir configuração manual, conforme links em `assets/brand/README.md`.
6. Painel Control Center #179 integrado, mas promoção canônica run 38070097812 bloqueada por `CLOUDFLARE_API_TOKEN_REQUIRED`. Não contornar com provedor não autorizado.

**Decisão:** NÃO emitir "BLOCO CONCLUÍDO" / "100% fechado" até cada linha externa ter recibo/readback, URL e aceitação real em produção.
