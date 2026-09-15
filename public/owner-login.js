const form=document.getElementById('owner-login-form');
const input=document.getElementById('owner-password');
const status=document.getElementById('owner-login-status');
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  const password=String(input?.value||'');
  if(password.length<8){status.textContent='Credencial invÃ¡lida.';return;}
  const button=form.querySelector('button');button.disabled=true;status.textContent='Validando acessoâ€¦';
  try{
    const response=await fetch('/auth/owner/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
    if(!response.ok){status.textContent=response.status===401?'Senha invÃ¡lida.':'NÃ£o foi possÃ­vel autenticar agora.';return;}
    status.textContent='Acesso autorizado. Abrindo Centralâ€¦';
    location.replace('/central');
  }catch{status.textContent='Falha de conexÃ£o. Tente novamente.';}
  finally{button.disabled=false;input.value='';}
});
