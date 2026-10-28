// LOW-2 (reauditoria do PR #946, rodada 4): com WAITLIST_ENABLED desligado, o Worker central REAL responde 404 em
// /lista-de-espera sem nenhuma operação de KV. Processo próprio (o bundle carregado pelos hooks mantém handles vivos).
import { register } from "node:module";
register("../t4_sim/hooks.mjs", import.meta.url);
const W = (await import("../../worker/cloudflare-worker.compat.mjs")).default;
let ops = 0;
const kv = { async get() { ops++; throw new Error("kv_read"); }, async put() { ops++; }, async list() { ops++; return { keys: [] }; }, async delete() { ops++; } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const out = [];
for (const path of ["/lista-de-espera", "/lista-de-espera?produto=ia-na-pratica", "/lista-de-espera/confirmar?t=x"]) {
  const r = await W.fetch(new Request("https://zevanory.api.br" + path), { ZEVANORY_PRIVATE_ARTIFACTS: kv }, ctx);
  out.push({ path, status: r.status, kv_ops: ops });
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exit(0);
