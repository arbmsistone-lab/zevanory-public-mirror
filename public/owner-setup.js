const form=document.getElementById('owner-setup-form');
const password=document.getElementById('owner-password');
const confirm=document.getElementById('owner-password-confirm');
const status=document.getElementById('owner-setup-status');
const params=new URLSearchParams(location.hash.slice(1));
const token=String(params.get('token')||'');
history.replaceState(null,'',location.pathname);
if(token.length<32){status.textContent='Link de configuraÃ§Ã£o invÃ¡lido ou expirado.';form?.querySelector('button')?.setAttribute('disabled','disabled');}
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  const value=String(password?.value||''),again=String(confirm?.value||'');
  if(value.length<8){status.textContent='Use pelo menos 8 caracteres.';return;}
  if(value!==again){status.textContent='As senhas nÃ£o coincidem.';return;}
  const button=form.querySelector('button');button.disabled=true;status.textContent='Salvando acessoâ€¦';
  try{
    const response=await fetch('/auth/owner/setup',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({token,password:value})});
    if(!response.ok){status.textContent=response.status===403?'Link invÃ¡lido ou jÃ¡ utilizado.':'NÃ£o foi possÃ­vel salvar agora.';return;}
    status.textContent='Senha definida. Abrindo Centralâ€¦';
    location.replace('/central');
  }catch{status.textContent='Falha de conexÃ£o. Tente novamente.';}
  finally{button.disabled=false;password.value='';confirm.value='';}
});
