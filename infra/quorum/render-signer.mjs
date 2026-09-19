import http from "node:http";
import { createHash, createPrivateKey, constants, sign } from "node:crypto";
import { readFileSync } from "node:fs";
const k = JSON.parse(readFileSync("infra/quorum/render-key.json", "utf8"));
const sha = process.env.ZEVANORY_RELEASE_SHA;
const id = process.env.ZEVANORY_RELEASE_ID;
const policy = process.env.ZEVANORY_POLICY_VERSION;
const provider = "render-free";
const root = createHash("sha256").update("ZEVANORY|" + id + "|" + sha + "|" + policy).digest("hex");
const pub = JSON.stringify(k.public_jwk);
const keyId = createHash("sha256").update(pub).digest("hex");
const payload = ["zevanory-provider-attestation/v1", provider, id, sha, root, policy].join("|");
const privateKey = createPrivateKey({ key: k.private_jwk, format: "jwk" });
const signature = sign("sha256", Buffer.from(payload), {
  key: privateKey,
  padding: constants.RSA_PKCS1_PSS_PADDING,
  saltLength: 32
}).toString("base64url");
const body = JSON.stringify({
  service: "ZEVANORY",
  provider,
  release_id: id,
  fail_closed: true,
  public_sales_locked: true,
  quorum_attestation: {
    schema: "zevanory-quorum-attestation/v2",
    artifact_sha: sha,
    evidence_root: root,
    policy_version: policy,
    provider,
    algorithm: "sha256",
    signed_payload: payload,
    signature: { alg: "PS256", key_id: keyId, public_jwk: k.public_jwk, value: signature }
  }
});
http.createServer((_req, res) => {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-zevanory-artifact-sha": sha,
    "x-zevanory-evidence-root": root,
    "x-zevanory-policy-version": policy,
    "x-zevanory-key-id": keyId
  });
  res.end(body);
}).listen(process.env.PORT || 10000);

