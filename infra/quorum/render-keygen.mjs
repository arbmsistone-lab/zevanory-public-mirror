import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
writeFileSync("infra/quorum/render-key.json", JSON.stringify({
  private_jwk: privateKey.export({ format: "jwk" }),
  public_jwk: publicKey.export({ format: "jwk" })
}));
console.log("RENDER_QUORUM_KEYGEN=PASS");

