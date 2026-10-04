const PHONE_ID="1300972319774588";
const SELF=new Set(["558892545413","5588992545413"]);
export function whatsappInboundSafety(item){
 const from=String(item?.from||"").replace(/\D/g,"");
 if(SELF.has(from))return "self_sender";
 if(String(item?.phone_number_id||"")!==PHONE_ID)return "phone_number_mismatch";
 return null;
}
export async function resolveOwnerProof(sql){
 const leads=await sql.query("select contact_ref, updated_at from sales_leads where channel='whatsapp' and contact_ref not in ('558892545413','5588992545413') order by updated_at desc limit 3");
 for(const lead of leads){
  const contact=String(lead.contact_ref||"").replace(/\D/g,"");
  if(!/^55\d{10,11}$/.test(contact)||SELF.has(contact))continue;
  const events=await sql.query("select j.payload,j.created_at from agent_jobs j join sales_leads l on l.lead_id=j.lead_id where l.channel='whatsapp' and l.contact_ref=$1 and j.created_at >= '2026-10-04T03:00:00Z'::timestamptz and j.created_at < '2026-10-05T03:00:00Z'::timestamptz order by j.created_at desc limit 100",[lead.contact_ref]);
  const real=events.filter(e=>!String(e.payload?.message_id||"").startsWith("internal-"));
  const text=real.find(e=>/^s[oó]\s+texto[.!]?$/i.test(String(e.payload?.inbound_message||"").trim())&&Math.abs(new Date(e.created_at).getTime()-Date.parse("2026-10-04T19:55:00Z"))<=10*60*1000);
  const audio=real.find(e=>e.payload?.media_type==="audio");
  if(text&&audio)return {recipient:contact,recipient_suffix:contact.slice(-4),evidence:{text_at:text.created_at,audio_at:audio.created_at,text:"so texto",audio:true}};
 }
 throw Error("owner_proof_evidence_not_found");
}
