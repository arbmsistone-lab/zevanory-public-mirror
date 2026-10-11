import test from "node:test";
import assert from "node:assert/strict";
import { handleOwnerOAuth, handlePublisherAccess, OAUTH_PROVIDERS } from "../worker/owner-oauth.mjs";
const kv = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); }, delete: async k => { m.delete(k); } }; };
test("TikTok is a first-class owner OAuth channel with Login Kit v2 endpoints", () => {
  assert.equal(OAUTH_PROVIDERS.tiktok.auth, "https://www.tiktok.com/v2/auth/authorize/");
  assert.equal(OAUTH_PROVIDERS.tiktok.scope, "user.info.basic,video.publish");
});
test("TikTok start/status stay owner-ticket gated", async () => {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv(), TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s" };
  const r = await handleOwnerOAuth(new Request("https://zevanory.api.br/api/owner/oauth/tiktok/start"), env);
  assert.equal(r.status, 401);
});
test("publisher access rejects unsigned requests and unknown channels", async () => {
  const env = { ZEVANORY_PRIVATE_ARTIFACTS: kv(), TIKTOK_CLIENT_SECRET: "secret-123456789" };
  const bad = await handlePublisherAccess(new Request("https://x/api", { method: "POST", body: JSON.stringify({ ts: String(Date.now()), nonce: "n".repeat(43), sig: "s".repeat(43) }) }), env, "tiktok");
  assert.equal(bad.status, 401);
  const unknown = await handlePublisherAccess(new Request("https://x/api", { method: "POST", body: "{}" }), env, "myspace");
  assert.equal(unknown.status, 404);
});
