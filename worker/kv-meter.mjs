// KV write meter (owner order METACLOUD, phase A): every put/delete on the shared KV namespace
// logs one line {kvw: "<prefix>", op, src} — no keys beyond their prefix, no values. The census
// workflow tails the Worker and turns these lines into writes per prefix and per trigger.
// Workers Free: 1,000 KV writes per day for the WHOLE account (reset 00:00 UTC).
export function kvPrefix(key) {
  const k = String(key || "");
  const parts = k.split(/[:/]/).filter(Boolean);
  // Keep the stable head of the key (e.g. "zpc:cron:v1", "postsale:sent"); drop ids and dates.
  const head = [];
  for (const p of parts) {
    if (/^[0-9a-f-]{8,}$/i.test(p) || /^\d{4}-\d{2}-\d{2}/.test(p) || /^\d{6,}/.test(p) || head.length >= 3) break;
    head.push(p);
  }
  return head.join(":") || "(root)";
}

export function meterKv(kv, src, log = (line) => console.log(line)) {
  if (!kv || typeof kv !== "object" || kv.__metered) return kv;
  return new Proxy(kv, {
    get(target, prop) {
      if (prop === "__metered") return true;
      const value = Reflect.get(target, prop);
      if ((prop === "put" || prop === "delete") && typeof value === "function") {
        return (key, ...rest) => {
          try { log(JSON.stringify({ kvw: kvPrefix(key), op: prop, src })); } catch {}
          return value.call(target, key, ...rest);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Env view whose private KV binding (and its Portuguese alias) is metered.
export function withMeteredKv(env, src, log) {
  if (!env || typeof env !== "object") return env;
  const names = new Set(["ZEVANORY_PRIVATE_ARTIFACTS", "ZEVANORY_ARTEFATOS_PRIVADOS"]);
  const cache = new Map();
  return new Proxy(env, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (!names.has(prop) || !value) return value;
      if (!cache.has(prop)) cache.set(prop, meterKv(value, src, log));
      return cache.get(prop);
    },
  });
}
