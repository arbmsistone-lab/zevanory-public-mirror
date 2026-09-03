const jsonType = value => String(value || '').toLowerCase().includes('application/json');

const parseBody = (raw, contentType) => {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (jsonType(contentType)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
};

export async function invokeLegacy(handler, request, options = {}) {
  const sourceUrl = new URL(request.url);
  const targetUrl = options.rewriteUrl ? options.rewriteUrl(sourceUrl) : sourceUrl;
  const rawBody = Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries([...request.headers.entries()].map(([k,v]) => [k.toLowerCase(), v]));
  const body = parseBody(rawBody, headers['content-type']);
  const query = Object.fromEntries(targetUrl.searchParams.entries());
  const req = {
    method: request.method,
    url: `${targetUrl.pathname}${targetUrl.search}`,
    headers,
    query,
    body,
    rawBody,
    parsedBody: body,
  };
  let statusCode = 200;
  const responseHeaders = new Headers();  let responseBody = '';
  const res = {
    set statusCode(value) { statusCode = Number(value) || 200; },
    get statusCode() { return statusCode; },
    setHeader(name, value) {
      if (Array.isArray(value)) value.forEach(v => responseHeaders.append(name, String(v)));
      else responseHeaders.set(name, String(value));
    },
    getHeader(name) { return responseHeaders.get(name); },
    write(chunk) { responseBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? ''); },
    end(chunk = '') {
      if (chunk !== undefined && chunk !== null) {
        responseBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
    },
  };
  await handler(req, res);
  const noBody = [204, 205, 304].includes(statusCode);
  return new Response(noBody ? null : responseBody, { status: statusCode, headers: responseHeaders });
}

export const withSearch = (url, key, value) => {
  const copy = new URL(url.toString());
  copy.searchParams.set(key, value);
  return copy;
};