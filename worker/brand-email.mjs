// Canonical visual shell for permitted ZEVANORY transactional and opt-in emails.
export const OFFICIAL_EMAIL_IMAGE="https://zevanory.api.br/brand/export/email-card.png";
export const OFFICIAL_LEGAL_FOOTER="A. RENAN ALVES MOREIRA BITU LTDA · CNPJ 69.077.233/0001-99 · Rua Francisco de Freitas Neto, 96, Casa Residencial, Alto do Tenente, Várzea Alegre/CE, CEP 63540-000 · suporte@zevanory.api.br · WhatsApp +55 88 99254-5413";
const escape=v=>String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
export function brandedEmailHtml(text,{unsubscribeUrl}={}){
 const optOut=unsubscribeUrl?'<p><a href="'+escape(unsubscribeUrl)+'">Descadastrar-se destes e-mails</a></p>':"";
 return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ZEVANORY</title></head><body style="margin:0;background:#05070b;color:#f5f7fb;font-family:Arial,sans-serif">'+
 '<main style="margin:0 auto;padding:20px;max-width:600px;background:#0b0f16">'+
 '<img src="'+OFFICIAL_EMAIL_IMAGE+'" width="560" height="294" style="max-width:100%;height:auto" alt="ZEVANORY · Menos improviso. Mais execução.">'+
 '<div style="white-space:pre-wrap;line-height:1.6;font-size:16px">'+escape(text)+'</div>'+
 '<hr style="border:0;border-top:1px solid #202a38;margin:20px 0"><p style="font-size:12px">'+escape(OFFICIAL_LEGAL_FOOTER)+'</p>'+optOut+'</main></body></html>';
}
