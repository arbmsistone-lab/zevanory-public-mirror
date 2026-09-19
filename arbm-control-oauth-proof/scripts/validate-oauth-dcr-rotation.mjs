import assert from 'node:assert/strict';
import oauthWorker from '../src/worker-oauth.js';

const BASE = 'https://arbm-control.zevanory.workers.dev';
const CALLBACK = 'https://chatgpt.com/connector/oauth/test_connector';
const OLD_ENV = {
  ARBM_SIGNING_KEY: 'old-signing-key-for-rotation-test',
  ARBM_ADMIN_KEY: 'admin-test-key',
  ARBM_DIRECT_BEARER: 'direct-test-token',
};
const NEW_ENV = {
  ...OLD_ENV,
  ARBM_SIGNING_KEY: 'new-signing-key-for-rotation-test',
};

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function register(env, redirectUris) {
  return oauthWorker.fetch(new Request(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: redirectUris }),
  }), env, {});
}

function authorizeRequest(clientId, redirectUri = CALLBACK) {
  const url = new URL(`${BASE}/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('code_challenge', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'rotation-regression');
  url.searchParams.set('scope', 'mcp offline_access');
  return new Request(url);
}

const registration = await register(OLD_ENV, [CALLBACK]);
assert.equal(registration.status, 201, await registration.text());
const client = await registration.json();
assert.equal(typeof client.client_id, 'string');
assert.ok(client.client_id.includes('.'));

const rotatedAuthorize = await oauthWorker.fetch(
  authorizeRequest(client.client_id),
  NEW_ENV,
  {},
);
assert.equal(
  rotatedAuthorize.status,
  200,
  `legacy ChatGPT DCR client must survive signing-key rotation; body=${await rotatedAuthorize.text()}`,
);

const evilRegistration = await register(NEW_ENV, ['https://evil.example/callback']);
assert.equal(evilRegistration.status, 400, 'DCR must reject non-ChatGPT callbacks');

const forgedEvilClient =
  `${b64urlJson({ typ: 'client', redirect_uris: ['https://evil.example/callback'], iat: Date.now() })}.forged`;
const forgedAuthorize = await oauthWorker.fetch(
  authorizeRequest(forgedEvilClient, 'https://evil.example/callback'),
  NEW_ENV,
  {},
);
assert.equal(forgedAuthorize.status, 400, 'legacy recovery must fail closed for untrusted callbacks');

const forgedQueryClient =
  `${b64urlJson({ typ: 'client', redirect_uris: [`${CALLBACK}?x=1`], iat: Date.now() })}.forged`;
const forgedQueryAuthorize = await oauthWorker.fetch(
  authorizeRequest(forgedQueryClient, `${CALLBACK}?x=1`),
  NEW_ENV,
  {},
);
assert.equal(forgedQueryAuthorize.status, 400, 'legacy recovery must reject callback query/hash variants');

console.log('OAUTH_DCR_ROTATION_COMPAT=PASS');
console.log('OAUTH_DCR_REDIRECT_ALLOWLIST=PASS');
console.log('OAUTH_DCR_FAIL_CLOSED=PASS');
