export function evaluateEmailReadiness({ mx = [], dkim = [], dmarc = [], env = process.env } = {}) {
  const expectedMx = 'inbound-smtp.sa-east-1.amazonaws.com';
  const mxOk = mx.some((row) => String(row.exchange || '').replace(/\.$/, '').toLowerCase() === expectedMx && Number(row.priority) === 10);
  const dkimText = dkim.flat().join(' ');
  const dmarcText = dmarc.flat().join(' ');
  const dns = Object.freeze({
    mx: mxOk,
    dkim: /\bp=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ/.test(dkimText),
    dmarc: /v=DMARC1;\s*p=none;?/i.test(dmarcText),
  });
  const secrets = Object.freeze({
    api_key: Boolean(String(env.RESEND_API_KEY || '').trim()),
    webhook_secret: Boolean(String(env.RESEND_WEBHOOK_SECRET || '').trim()),
  });
  const config = Object.freeze({
    forward_to: String(env.RESEND_FORWARD_TO || '') === 'zevanory@gmail.com',
    from_address: String(env.RESEND_FROM_ADDRESS || '').includes('contato@zevanory.api.br'),
    inbound_enabled: env.EMAIL_INBOUND_ENABLED === 'true',
  });
  const dnsReady = Object.values(dns).every(Boolean);
  const secretsReady = secrets.api_key && secrets.webhook_secret;
  const configReady = config.forward_to && config.from_address;
  return Object.freeze({ dns, secrets, config, dns_ready:dnsReady, secrets_ready:secretsReady, config_ready:configReady, activation_ready:dnsReady && secretsReady && configReady });
}
