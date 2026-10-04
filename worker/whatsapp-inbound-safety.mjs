const PHONE_ID="1300972319774588";
const SELF=new Set(["558892545413","5588992545413"]);
export function whatsappInboundSafety(item){
 const from=String(item?.from||"").replace(/\D/g,"");
 if(SELF.has(from))return "self_sender";
 if(String(item?.phone_number_id||"")!==PHONE_ID)return "phone_number_mismatch";
 return null;
}
export async function resolveOwnerProof(sql){
 const candidates=[];
 const leads=await sql.query("select contact_ref, updated_at from sales_leads where channel='whatsapp' and contact_ref not in ('558892545413','5588992545413') order by updated_at desc limit 3");
 for(const lead of leads){
  const contact=String(lead.contact_ref||"").replace(/\D/g,"");
  if(!/^55\d{10,11}$/.test(contact)||SELF.has(contact))continue;
  const memory=await sql.query("select m.updated_at,m.memory_value from agent_memory m join sales_leads l on m.scope_type='lead' and m.scope_ref=l.lead_id::text where l.channel='whatsapp' and l.contact_ref=$1 and m.memory_key='last_inbound_message' order by m.updated_at desc limit 3",[lead.contact_ref]);
  const events=await sql.query("select j.payload,j.created_at from agent_jobs j join sales_leads l on l.lead_id=j.lead_id where l.channel='whatsapp' and l.contact_ref=$1 and j.created_at >= '2026-10-04T03:00:00Z'::timestamptz and j.created_at < '2026-10-05T03:00:00Z'::timestamptz order by j.created_at desc limit 100",[lead.contact_ref]);
  const real=events.filter(e=>!String(e.payload?.message_id||"").startsWith("internal-"));
  const text=real.find(e=>/^s[oó]\s+texto[.!]?$/i.test(String(e.payload?.inbound_message||"").trim())&&Math.abs(new Date(e.created_at).getTime()-Date.parse("2026-10-04T19:55:00Z"))<=10*60*1000) || memory.find(e=>/^s[oó]\s+texto[.!]?$/i.test(String(e.memory_value?.text||"").trim())&&Math.abs(new Date(e.updated_at).getTime()-Date.parse("2026-10-04T19:55:00Z"))<=10*60*1000);
  const audio=real.find(e=>e.payload?.media_type==="audio");
  candidates.push({suffix:contact.slice(-4),updated_at:lead.updated_at,memory:memory.map(m=>({at:m.updated_at,text:String(m.memory_value?.text||"").replace(/\d{5,}/g,"[redacted]").slice(0,120)})),events:real.slice(0,20).map(e=>({at:e.created_at,type:e.payload?.media_type,text:String(e.payload?.inbound_message||"").replace(/\d{5,}/g,"[redacted]").slice(0,120)}))});
  if(text&&audio)return {recipient:contact,recipient_suffix:contact.slice(-4),evidence:{text_at:text.created_at||text.updated_at,audio_at:audio.created_at,text:"so texto",audio:true}};
 }
 const error=Error("owner_proof_evidence_not_found");error.candidates=candidates;throw error;
}
