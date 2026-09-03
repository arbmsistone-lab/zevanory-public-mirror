const sessionId = crypto.randomUUID();
const pilotToken = (() => {
  const match = location.hash.match(/(?:^#|&)pilot=([^&]+)/);
  if (!match) return '';
  const value = decodeURIComponent(match[1]);
  history.replaceState(null, '', location.pathname + location.search);
  return value;
})();

async function event(name) {
  const response = await fetch('/api/events/public', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({event_id: crypto.randomUUID(), name, session_id: sessionId, channel: 'certification_pilot'})
  });
  if (!response.ok) throw new Error('telemetry_rejected_' + response.status);
  return true;
}

async function startPilotCheckout() {
  const response = await fetch('/api/checkout', {
    method:'POST',
    headers:{'content-type':'application/json','x-certification-pilot-token':pilotToken},
    body:JSON.stringify({request_id:crypto.randomUUID(),session_id:sessionId})
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || !data.checkout_url) throw new Error(data.error || 'checkout_rejected');
  location.href = data.checkout_url;
}
(async () => {
  const button = document.getElementById('cta');
  const status = document.getElementById('status');
  try {
    const response = await fetch('/api/config', {cache:'no-store'});
    if (!response.ok) throw new Error('config_rejected_' + response.status);
    const config = await response.json();
    document.getElementById('offer').textContent = config.offer?.name || config.offer_id;
    document.getElementById('price').textContent = 'R$ ' + Number(config.experimental_price_brl).toLocaleString('pt-BR');
    try { await event('page_view'); } catch {}
    if (!pilotToken) {
      button.disabled = true;
      status.textContent = 'Piloto fechado por convite. Nenhuma venda publica esta liberada.';
      return;
    }
    if (!config.certification_pilot?.ready || config.commercial_enabled) {
      button.disabled = true;
      status.textContent = 'Convite reconhecido, mas o piloto ainda aguarda os gates externos obrigatorios.';
      return;
    }
    button.disabled = false;
    button.textContent = 'Ir para checkout seguro do piloto';
    status.textContent = 'Convite de certificacao presente. O servidor ainda validara identidade, capacidade e pagamento.';
    button.onclick = async () => {
      button.disabled = true;
      try { await startPilotCheckout(); }
      catch { status.textContent = 'Checkout bloqueado por validacao de seguranca. O convite pode ter expirado ou os gates ainda estao fechados.'; button.disabled=false; }
    };
  } catch {
    button.disabled = true;
    status.textContent = 'Piloto indisponivel por validacao de seguranca.';
  }
})();
