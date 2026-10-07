const token=String(process.env.TELEGRAM_BOT_TOKEN||""),chatId=String(process.env.TELEGRAM_CHANNEL_ID||"");
if(!token||!chatId)throw new Error("telegram_credentials_missing");
const api=async(method,body={})=>{const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const out=await r.json().catch(()=>({}));if(!r.ok||out.ok!==true)throw new Error(`telegram_${method}_failed`);return out.result;};
const me=await api("getMe"),chat=await api("getChat",{chat_id:chatId}),membership=await api("getChatMember",{chat_id:chatId,user_id:me.id});
if(String(chat.username||"").toLowerCase()!=="zevanory")throw new Error("telegram_channel_identity_mismatch");
if(!["administrator","creator"].includes(membership.status)||membership.status==="administrator"&&membership.can_post_messages!==true)throw new Error("telegram_bot_cannot_post");
const marker="ZEVANORY · canal oficial";
let message=chat.pinned_message&&String(chat.pinned_message.text||"").includes(marker)?chat.pinned_message:null;
if(!message){message=await api("sendMessage",{chat_id:chatId,text:`${marker}\n\nBem-vindo. Conteúdo prático sobre IA, vendas e operação, com clareza e sem promessas irreais.\n\nAcesse o material gratuito: https://zevanory.api.br/material-gratuito?utm_source=telegram&utm_medium=organic&utm_campaign=boas_vindas_canal`,disable_web_page_preview:false});await api("pinChatMessage",{chat_id:chatId,message_id:message.message_id,disable_notification:true});}
console.log(JSON.stringify({bot:`@${me.username}`,channel:`@${chat.username}`,can_post_messages:membership.status==="creator"||membership.can_post_messages===true,message_id:message.message_id,url:`https://t.me/${chat.username}/${message.message_id}`}));
