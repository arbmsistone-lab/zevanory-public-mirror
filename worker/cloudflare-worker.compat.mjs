import worker from "./cloudflare-worker.recovered.mjs";
import { normalizeEnv } from "./binding-aliases.mjs";

const wrapped = {
  async fetch(request, env, ctx) {
    return worker.fetch(request, normalizeEnv(env), ctx);
  }
};

if (typeof worker.scheduled === "function") {
  wrapped.scheduled = async (controller, env, ctx) => worker.scheduled(controller, normalizeEnv(env), ctx);
}
if (typeof worker.queue === "function") {
  wrapped.queue = async (batch, env, ctx) => worker.queue(batch, normalizeEnv(env), ctx);
}
if (typeof worker.email === "function") {
  wrapped.email = async (message, env, ctx) => worker.email(message, normalizeEnv(env), ctx);
}

export default wrapped;
