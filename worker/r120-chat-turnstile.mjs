// R120 / DEC-20. Cloudflare Turnstile is used only for an explicitly initiated chat session.
// Fail closed if no secret, no valid one-use token, wrong action/hostname or provider error.
export const CHAT_HOSTNAMES=Object.freeze(["vendas.zevanory.api.br","zevanory.api.br"]);
export const CHAT_TURNSTILE_ACTION="zevanory_chat";
export async function verifyChatTurnstile(token,env={},fetchImpl=fetch){
  if(String(env.SITE_CHAT_SANDBOX||"").toLowerCase()==="true")return true; // test-only; production guard already prohibits sandbox
  const secret=String(env.SITE_CHAT_TURNSTILE_SECRET||"");
  if(!secret||typeof token!=="string"||!token||token.length>2048)return false;
  try{
    const response=await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret,response:token}),
      signal:AbortSignal.timeout(6000)
    });
    if(!response.ok)return false;
    const data=await response.json();
    return data?.success===true&&CHAT_HOSTNAMES.includes(data.hostname)&&data.action===CHAT_TURNSTILE_ACTION;
  }catch{return false;}
}
