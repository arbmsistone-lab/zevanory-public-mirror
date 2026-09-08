const host = value => String(value || '').replace(/\.$/, '').toLowerCase();
const txt = value => String(value || '').replace(/^"|"$/g, '').replace(/\s+/g, '');

// providerDomain must come from a fresh, authenticated Resend domain lookup.
// Activation readiness is a preflight, never proof of receipt or delivery.
export function evaluateEmailReadiness({ mx = [], dkim = [], dmarc = [], env = process.env, providerDomain = null, webhookVerified = false } = {}) {
  const domainMatches = providerDomain?.name === 'zevanory.api.br';
  const records = domainMatches ? (providerDomain.records || []) : [];
  const inbound = records.filter(r => r.type === 'MX' && ['@', '', 'zevanory.api.br'].includes(host(r.name)));
  const signing = records.filter(r => r.type === 'TXT' && r.record === 'DKIM');
  const lowest = Math.min(...mx.map(r => Number(r.priority)));
  const dns = Object.freeze({
    mx: inbound.length > 0 && inbound.every(r => mx.some(row => host(row.exchange) === host(r.value) && Number(row.priority) === Number(r.priority) && Number(row.priority) === lowest)),
    dkim: signing.length > 0 && signing.every(r => dkim.some(row => txt(row.join('')) === txt(r.value))),
    dmarc: dmarc.length === 1 && /^v=DMARC1\s*;/i.test(dmarc[0].join('')) && /(?:^|;)\s*p=(none|quarantine|reject)\s*(?:;|$)/i.test(dmarc[0].join('')),
  });
  const secrets = Object.freeze({
    api_key: Boolean(String(env.RESEND_API_KEY || '').trim()),
    webhook_secret: Boolean(String(env.RESEND_WEBHOOK_SECRET || '').trim()),
  });
  const config = Object.freeze({
    forward_to: String(env.RESEND_FORWARD_TO || '') === 'zevanory@gmail.com',
    from_address: /^(?:ZEVANORY\s*<contato@zevanory\.api\.br>|contato@zevanory\.api\.br)$/.test(String(env.RESEND_FROM_ADDRESS || '').trim()),
    inbound_enabled: env.EMAIL_INBOUND_ENABLED === 'true',
  });
  const provider = Object.freeze({
    domain_verified: domainMatches && providerDomain.status === 'verified',
    receiving_enabled: domainMatches && providerDomain.capabilities?.receiving === 'enabled',
    records_verified: inbound.length > 0 && signing.length > 0 && [...inbound, ...signing].every(r => r.status === 'verified'),
    webhook_verified: webhookVerified === true,
  });
  const dnsReady = Object.values(dns).every(Boolean);
  const secretsReady = Object.values(secrets).every(Boolean);
  const configReady = Object.values(config).every(Boolean);
  const providerReady = Object.values(provider).every(Boolean);
  return Object.freeze({ dns, secrets, config, provider, dns_ready: dnsReady, secrets_ready: secretsReady, config_ready: configReady, provider_ready: providerReady, activation_ready: dnsReady && secretsReady && configReady && providerReady, evidence_type: 'PROVIDER_PREFLIGHT', delivery_proven: false });
}
