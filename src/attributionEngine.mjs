const normalizeTouch=(touch,index)=>Object.freeze({
  id:String(touch?.id||`touch-${index+1}`),
  channel:String(touch?.channel||'unknown').toLowerCase(),
  occurred_at:touch?.occurred_at?new Date(touch.occurred_at).toISOString():null,
});

export function normalizeTouchpoints(input=[]){
  return Object.freeze((Array.isArray(input)?input:[]).map(normalizeTouch));
}

const credits=(touches,weights)=>Object.freeze(touches.map((touch,index)=>Object.freeze({...touch,credit:weights[index]})));

export function attributeRevenue({touchpoints=[],revenue_brl=0,model='linear'}={}){
  const touches=normalizeTouchpoints(touchpoints);
  const n=touches.length;
  const revenue=Math.max(0,Number(revenue_brl)||0);
  if(n===0) return Object.freeze({model,attributed:false,revenue_brl:revenue,touchpoints:Object.freeze([]),by_channel:Object.freeze({})});
  let weights=[];
  if(model==='first_touch') weights=touches.map((_t,i)=>i===0?1:0);
  else if(model==='last_touch') weights=touches.map((_t,i)=>i===n-1?1:0);
  else if(model==='position_based'&&n>1){ weights=touches.map((_t,i)=>i===0||i===n-1?0.4:(0.2/Math.max(1,n-2))); }
  else weights=touches.map(()=>1/n);
  const detail=credits(touches,weights);
  const byChannel={};
  for(const item of detail) byChannel[item.channel]=(byChannel[item.channel]||0)+(item.credit*revenue);
  return Object.freeze({model,attributed:true,revenue_brl:revenue,touchpoints:detail,by_channel:Object.freeze(byChannel)});
}
