import http from 'node:http';
const HOST='127.0.0.1',PORT=53682;
const EXCHANGE='https://zevanory.api.br/api/oauth/youtube/loopback-exchange';
const START='https://zevanory.api.br/api/oauth/youtube/start?mode=loopback';
const html=(ok,msg)=>`<!doctype html><meta charset="utf-8"><title>ZEVANORY YouTube</title><body style="font-family:system-ui;background:#07111d;color:white;padding:40px"><h1>${ok?'ZEVANORY YouTube conectado':'Falha na autorização'}</h1><p>${msg}</p></body>`;
let done=false;
const server=http.createServer(async(req,res)=>{
 if(done){res.writeHead(410,{'content-type':'text/plain'});return res.end('expired');}
 const u=new URL(req.url||'/',`http://${HOST}:${PORT}`);const code=u.searchParams.get('code')||'',state=u.searchParams.get('state')||'',err=u.searchParams.get('error')||'';
 if(err||!code||!state){done=true;res.writeHead(400,{'content-type':'text/html; charset=utf-8'});res.end(html(false,err||'callback incompleto'));console.log(JSON.stringify({connected:false,error:err||'callback_incomplete'}));return server.close();}
 try{const r=await fetch(EXCHANGE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,state})});const b=await r.json().catch(()=>({}));done=true;res.writeHead(r.ok?200:503,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html(r.ok,r.ok?'Descrição institucional padronizada. Pode fechar esta aba.':String(b.error||'provider_error')));console.log('ZEVANORY_YOUTUBE_LOOPBACK '+JSON.stringify(b));server.close();}
 catch(e){done=true;res.writeHead(503,{'content-type':'text/html; charset=utf-8'});res.end(html(false,'Falha de transporte.'));console.log(JSON.stringify({connected:false,error:String(e.message||e)}));server.close();}
});
server.listen(PORT,HOST,()=>console.log(`YOUTUBE_LOOPBACK_READY ${START}`));
setTimeout(()=>{if(!done){console.log('YOUTUBE_LOOPBACK_TIMEOUT');server.close();}},10*60*1000).unref();