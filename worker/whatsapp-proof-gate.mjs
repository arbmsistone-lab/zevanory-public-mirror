const indexOfStage=(steps,name)=>steps.findIndex(step=>step?.stage===name);

export function hasVoiceDeliveryProof(last={}){
  const steps=Array.isArray(last.steps)?last.steps:[];
  const tts=indexOfStage(steps,"tts_done");
  const encoded=Math.max(indexOfStage(steps,"encode_done"),indexOfStage(steps,"encode_skipped_provider_encoded"));
  const uploaded=indexOfStage(steps,"upload_done");
  const sent=indexOfStage(steps,"voice_sent");
  return last.voice_sent===true&&/^wamid\./.test(String(last.voice_provider_message_id||""))&&tts>=0&&encoded>tts&&uploaded>encoded&&sent>uploaded;
}
