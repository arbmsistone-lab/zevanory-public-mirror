const $=(id)=>document.getElementById(id);
async function refreshStatus(){
  $('status').textContent='Consultando conexão segura...';
  try{
    const r=await fetch('/api/oauth/tiktok/callback',{cache:'no-store'});
    const j=await r.json();
    $('status').textContent=j.authorization_enabled?'OAuth configurado no servidor.':'OAuth ainda sem credenciais de produção.';
  }catch{$('status').textContent='Não foi possível consultar o status agora.';}
}
$('refresh').addEventListener('click',refreshStatus);
$('prepare').addEventListener('click',()=>{
  const consent=$('consent').checked;
  const media=$('media').value.trim();
  let valid=false;
  try{const u=new URL(media);valid=u.protocol==='https:';}catch{}
  if(!consent){$('result').textContent='Bloqueado: consentimento explícito é obrigatório.';return;}
  if(!valid){$('result').textContent='Bloqueado: informe uma URL HTTPS válida do vídeo.';return;}
  $('result').textContent='Validação local concluída. A publicação real permanece sujeita ao OAuth e aos gates do servidor.';
});
refreshStatus();