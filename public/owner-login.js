const form=document.getElementById('owner-login-form');
const input=document.getElementById('owner-password');
const status=document.getElementById('owner-login-status');
form?.addEventListener('submit',async event=>{
  event.preventDefault();
  const password=String(input?.value||'');
  if(password.length<8){status.textContent='Credencial inválida.';return;}
  const button=form.querySelector('button');button.disabled=true;status.textContent='Validando acesso…';
  try{
    const response=await fetch('/auth/owner/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
    if(!response.ok){status.textContent=response.status===401?'Senha inválida.':'Não foi possível autenticar agora.';return;}
    status.textContent='Acesso autorizado. Abrindo Central…';
    location.replace('/central');
  }catch{status.textContent='Falha de conexão. Tente novamente.';}
  finally{button.disabled=false;input.value='';}
});