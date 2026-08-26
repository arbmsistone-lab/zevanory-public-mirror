const base = String(process.env.PROBE_BASE_URL || 'https://zevanory.api.br').replace(/\/$/, '');
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 8000);
const expectedRelease = String(process.env.EXPECTED_RELEASE_ID || '').trim();
const targets = Object.freeze([
  ['/api/live', (body) => body.live === true],
  ['/api/health', (body) => body.ready === true && body.checks?.schema_ready === true],
  ['/api/release', (body) => !expectedRelease || body.release_id === expectedRelease],
  ['/api/status', (body) => body.engine?.technical_infrastructure === 'approved'],
]);

async function probe(path, validate) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${base}${path}`, { headers: { 'x-request-id': `probe-${crypto.randomUUID()}` }, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    const ok = response.ok && validate(body);
    return { path, ok, status: response.status, duration_ms: Date.now() - started };
  } catch (error) {
    return { path, ok: false, status: 0, duration_ms: Date.now() - started, error: error?.name === 'AbortError' ? 'timeout' : 'request_failed' };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(targets.map(([path, validate]) => probe(path, validate)));
const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ service: 'ZEVANORY', ok: failed.length === 0, checked_at: new Date().toISOString(), results }));
if (failed.length) process.exit(1);
