// NC-017 (DEC-02/04/05, DEC-01 v3): exact hunks between the Worker at 81d637e (git blob
// aecd9bff0e23d75aec0023e5ed46079a97accf3b) and the current Worker, as [current, previous] pairs.
// tests/sales-worker-differential.test.mjs reverse-applies them (then #914's hunks) and pins both
// blobs, so ANY other change to worker/sales-public-worker.mjs fails the differential. Regenerate
// only together with an audited change to the Worker, and add its behaviour to the intended diffs.
export const NC017_SALES_WORKER_HUNKS = Object.freeze([
 [
  "import { CONTACT_HTML, CONTACT_LABEL, DELIVERY_72H, DELIVERY_TEXT, RESUMO_OFERTA, RULE_7D, RULE_LINE, contactHref, waitlistHref } from \"./politica-unica.mjs\";\nimport {cpSalesEnabled,isCpPublicRoute,cpClosedResponse,isMpPhase1CheckoutEnabled} from \"./nc015-sales-scope.mjs\";\n",
  "import { CONTACT_HTML, CONTACT_LABEL, DELIVERY_72H, DELIVERY_TEXT, RESUMO_OFERTA, RULE_7D, RULE_LINE, contactHref, waitlistHref } from \"./politica-unica.mjs\";\n"
 ],
 [
  "  aprovado:[\"Recebemos o seu retorno do pagamento\",\"<p>Assim que o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra. Costuma levar poucos minutos.</p><p>Não chegou? Confira a caixa de spam ou promoções. Você também pode <a href=\\\"https://zevanory.api.br/entrega/reenviar\\\">pedir um novo link de acesso</a>.</p>\"],\n  pendente:[\"Acompanhe o seu pagamento\",\"<p>Se você pagou com Pix à vista, a compensação pode levar algum tempo. Quando o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra.</p><p>Se já pagou e nada chegou em 1 dia útil, <a href=\\\"https://zevanory.api.br/entrega/reenviar\\\">peça um novo link</a> ou fale com a gente: \"+CONTACT_HTML+\".</p>\"],\n",
  "  aprovado:[\"Recebemos o seu retorno do pagamento\",\"<p>Assim que o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra. Costuma levar poucos minutos.</p><p>Não chegou? Confira a caixa de spam ou promoções. Você também pode <a href=\\\"https://zevanory.api.br/entrega/reenviar\\\">pedir um novo link de acesso</a>.</p>\"],\n  pendente:[\"Acompanhe o seu pagamento\",\"<p>Se você pagou com Pix ou boleto, a compensação pode levar algum tempo. Quando o Mercado Pago confirmar o pagamento, o acesso chega no e-mail informado na compra.</p><p>Se já pagou e nada chegou em 1 dia útil, <a href=\\\"https://zevanory.api.br/entrega/reenviar\\\">peça um novo link</a> ou fale com a gente: \"+CONTACT_HTML+\".</p>\"],\n"
 ],
 [
  "}\nconst PRICES={\"ZEV-IA-011\":[\"IA na Prática\",97],\"ZEV-VEN-011\":[\"Vendas na Prática\",97],\"ZEV-LCX-011\":[\"Lucro & Caixa\",147],\"ZEV-CMB-011\":[\"Combo IA + Vendas\",157],\"ZEV-NGC-011\":[\"Negócio Completo\",247]};\n",
  "}\nconst PRICES={\"ZEV-IA-011\":[\"IA na Prática\",197],\"ZEV-VEN-011\":[\"Vendas na Prática\",197],\"ZEV-LCX-011\":[\"Lucro & Caixa\",247],\"ZEV-CMB-011\":[\"Combo IA + Vendas\",297],\"ZEV-NGC-011\":[\"Negócio Completo\",397]};\n"
 ],
 [
  "  if(!slug) return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe ou foi retirado.</p>\");\n  // DEC-05: while Mercado Pago is excluded, direct GET/HEAD go only to the\n  // fail-closed Hotmart variant. POST never creates an own-checkout transaction.\n  if(!isMpPhase1CheckoutEnabled()){\n    if(request.method!==\"GET\"&&request.method!==\"HEAD\")return infoPage(503,\"Checkout próprio indisponível\",\"<p>Na primeira fase, os guias e kits usam somente a Hotmart.</p>\");\n    if(!(await salesOpen(env)))return infoPage(200,\"Vendas abrem em breve\",`<p>O ${PRICES[sku][0]} ainda não está à venda. Para dúvidas, escreva para ${CONTACT_HTML}.</p>`);\n    return new Response(null,{status:302,headers:applySecurityHeaders(new Headers({location:\"/hotmart/\"+slug,\"cache-control\":\"no-store\"}))});\n  }\n",
  "  if(!slug) return infoPage(404,\"Produto não encontrado\",\"<p>Esse produto não existe ou foi retirado.</p>\");\n"
 ],
 [
  "const SERVICE_WA=contactHref(\"Olá! Quero assinar o Conteúdo Pronto.\");\nexport const HOTMART_TEXT=[\n  // Every left operand is exact generated phase-one product copy; verified by NC-017 tests.\n  [\"Pagamento processado pelo Mercado Pago (Pix ou cartão)\",\"Pagamento processado pela Hotmart (Pix à vista ou cartão)\"],\n  [`PDFs e ZIP por e-mail ${DELIVERY_72H}; acesso online e planilhas imediatamente`,\"Acesso online e planilhas após a aprovação pela Hotmart; PDFs e ZIP liberados por e-mail após 192 horas (8 dias).\"],\n",
  "const SERVICE_WA=contactHref(\"Olá! Quero assinar o Conteúdo Pronto.\");\nconst HOTMART_TEXT=[\n  // Design PR: the hero payment facts are a list (no \"·\" chain); each item has its Hotmart wording.\n  [\"Pagamento processado pelo Mercado Pago (Pix ou cartão)\",\"Pagamento processado pela Hotmart (Pix, cartão ou boleto)\"],\n  [`Entrega por e-mail em ${DELIVERY_72H}`,\"Acesso por e-mail após a confirmação do pagamento\"],\n"
 ],
 [
  "  [\"<strong>Pagamento</strong><span>processado pelo Mercado Pago\",\"<strong>Pagamento</strong><span>processado pela Hotmart\"],\n  [\"Pagamento por Pix à vista ou cartão na plataforma indicada no checkout. O acesso online e as planilhas são liberados após a aprovação. Os PDFs e o pacote ZIP são enviados por e-mail 192 horas (8 dias) após a aprovação do pagamento, ao fim do prazo de garantia.\",\"Pagamento pela Hotmart (Pix à vista ou cartão). O acesso online e as planilhas são imediatos após aprovação. Os PDFs e o pacote ZIP chegam por e-mail 192 horas (8 dias) após a aprovação do pagamento.\"],\n",
  "  [\"<strong>Pagamento</strong><span>processado pelo Mercado Pago\",\"<strong>Pagamento</strong><span>processado pela Hotmart\"],\n  [`Entrega por e-mail após a confirmação do pagamento (Pix ou cartão pelo Mercado Pago), em ${DELIVERY_72H}.`,\"Acesso após a confirmação do pagamento, pela Hotmart. Os dados de acesso chegam no seu e-mail.\"],\n  [`Após a confirmação do pagamento (Pix ou cartão via Mercado Pago), você recebe por e-mail um ${DELIVERY_72H} do arquivo .zip com todo o material. A expiração do link não elimina o seu direito ao produto: peça outro sem custo em zevanory.api.br/entrega/reenviar.`,\"Após a confirmação do pagamento, a Hotmart envia ao seu e-mail o acesso para baixar todo o material. Você também encontra o produto em Minhas compras, na sua conta Hotmart.\"],\n"
 ],
 [
  "  [`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça em zevanory.api.br/pedir-reembolso.`,`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça pela Hotmart, em Minhas compras.`],\n  [\"Pix ou cartão pelo Mercado Pago.\",\"Pix à vista ou cartão pela Hotmart.\"],\n  [\"O acesso online e as planilhas ficam disponíveis após a aprovação; PDFs e ZIP por e-mail 192 horas (8 dias) após a aprovação do pagamento.\",\"Acesso online e planilhas pela Hotmart após a aprovação; PDFs e ZIP por e-mail 192 horas (8 dias) depois.\"],\n",
  "  [`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça em zevanory.api.br/pedir-reembolso.`,`Você pode desistir em ${RULE_7D}, sem justificativa e com devolução integral: peça pela Hotmart, em Minhas compras.`],\n  [\"Pix ou cartão pelo Mercado Pago.\",\"Pix, cartão ou boleto pela Hotmart.\"],\n  [\"Por e-mail após a confirmação do pagamento: válido por 72 horas e para um download.\",\"Acesso por e-mail logo após a confirmação do pagamento.\"],\n"
 ],
 [
  "  for(const [from,to] of HOTMART_TEXT)out=out.split(from).join(to);\n  // A stale pair must never leak own-checkout copy into a Hotmart purchase page.\n  const visible=out.replace(/<script type=\"application\\/ld\\+json\">[\\s\\S]*?<\\/script>/g,\"\");\n  if(/Mercado Pago|pedir-reembolso|entrega\\/reenviar/.test(visible))throw Error(\"hotmart_copy_rewrite_incomplete\");\n",
  "  for(const [from,to] of HOTMART_TEXT)out=out.split(from).join(to);\n"
 ],
 [
  "  const headers=applySecurityHeaders(new Headers({\"content-type\":\"text/html; charset=utf-8\",\"cache-control\":\"no-store\",\"x-robots-tag\":\"noindex, follow\"}));  // never cache a purchase link past a switch change\n  try{return new Response(hotmartPage(await page.text(),slug,checkout),{status:200,headers})}\n  catch{return infoPage(503,\"Oferta indisponível\",\"<p>Os dados de pagamento e entrega estão sob revisão. Nenhum checkout foi aberto.</p>\")}\n",
  "  const headers=applySecurityHeaders(new Headers({\"content-type\":\"text/html; charset=utf-8\",\"cache-control\":\"no-store\",\"x-robots-tag\":\"noindex, follow\"}));  // never cache a purchase link past a switch change\n  return new Response(hotmartPage(await page.text(),slug,checkout),{status:200,headers});\n"
 ],
 [
  "  const url=new URL(request.url);\n  // NC-015 / DEC-04: the subscription cannot become purchasable through\n  // an independent sales switch or a stale direct URL.\n  if(!cpSalesEnabled() && isCpPublicRoute(url.pathname)){\n    // Same HSTS/CSP/frame/referrer/permissions headers as every other sales-host response.\n    const closed=cpClosedResponse();\n    return new Response(request.method===\"HEAD\"?null:closed.body,{status:closed.status,headers:applySecurityHeaders(new Headers(closed.headers))});\n  }\n",
  "  const url=new URL(request.url);\n"
 ]
]);
export const NC017_BASE_BLOB = "aecd9bff0e23d75aec0023e5ed46079a97accf3b";
