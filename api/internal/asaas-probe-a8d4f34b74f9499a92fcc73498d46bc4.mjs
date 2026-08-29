export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok:false });
  const key = process.env.ASAAS_API_KEY || '';
  if (!key) return res.status(200).json({ ok:false, key_present:false, provider_http:null });
  try {
    const r = await fetch('https://api.asaas.com/v3/myAccount', { headers:{ access_token:key } });
    return res.status(200).json({ ok:r.ok, key_present:true, provider_http:r.status });
  } catch {
    return res.status(200).json({ ok:false, key_present:true, provider_http:'network_error' });
  }
}
