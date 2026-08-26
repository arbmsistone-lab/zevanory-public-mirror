const sessionId = crypto.randomUUID();
async function event(name) {
  const response = await fetch('/api/events/public', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({event_id: crypto.randomUUID(), name, session_id: sessionId, channel: 'landing'})
  });
  if (!response.ok) throw new Error('telemetry_rejected_' + response.status);
  return true;
}
(async () => {
  const button = document.getElementById('cta');
  const status = document.getElementById('status');
  try {
    const response = await fetch('/api/config', {cache:'no-store'});
    if (!response.ok) throw new Error('config_rejected_' + response.status);
    const config = await response.json();
    document.getElementById('offer').textContent = config.offer_id;
    document.getElementById('price').textContent = 'R$ ' + Number(config.experimental_price_brl).toLocaleString('pt-BR');
    try { await event('page_view'); } catch {}
    if (!config.whatsapp_enabled) {
      button.disabled = true;
      status.textContent = 'Vendas bloqueadas. Ativação comercial somente após aprovação de todos os gates pré-venda.';
      return;
    }
    button.disabled = false;
    status.textContent = 'Canal oficial configurado e telemetria ativa.';
    button.onclick = async () => {
      button.disabled = true;
      try {
        await event('cta_whatsapp');
        const text = encodeURIComponent('Olá, quero entender o piloto de IA aplicada a Vendas e Atendimento no WhatsApp.');
        location.href = 'https://wa.me/' + config.whatsapp_number + '?text=' + text;
      } catch {
        status.textContent = 'Não foi possível registrar o contato com segurança. Tente novamente.';
        button.disabled = false;
      }
    };
  } catch (error) {
    button.disabled = true;
    status.textContent = 'CTA bloqueado por validação de segurança.';
  }
})();
