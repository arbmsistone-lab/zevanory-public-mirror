// Loader hooks for tests/helpers/dec05-lifted.mjs (tests only; never imported by a Worker).
// A module imported with the query flag below gets its OWN copy of worker/nc015-sales-scope.mjs in which the
// DEC-05 phase-one lock (MP_PHASE1_CHECKOUT_ENABLED) is lifted. Every other import is shared and untouched,
// so the default (locked) graph used by the rest of the test file is never affected.
const FLAG = "zev-dec05-lifted";
const SCOPE = /\/worker\/nc015-sales-scope\.mjs$/;
const LOCK = "export const MP_PHASE1_CHECKOUT_ENABLED=false;";
const lifted = (href) => { try { return new URL(href).searchParams.has(FLAG); } catch { return false; } };

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (context.parentURL && lifted(context.parentURL) && r.url.startsWith("file:") && SCOPE.test(new URL(r.url).pathname)) {
    const u = new URL(r.url);
    u.searchParams.set(FLAG, "1");
    return { ...r, url: u.href };
  }
  return r;
}

export async function load(url, context, next) {
  const r = await next(url, context);
  if (!url.startsWith("file:") || !lifted(url) || !SCOPE.test(new URL(url).pathname)) return r;
  const src = typeof r.source === "string" ? r.source : Buffer.from(r.source).toString("utf8");
  const text = src.replace(/\r\n/g, "\n");
  // Fail closed: if the lock is no longer written exactly like this, the simulation must not pretend to work.
  if (text.split(LOCK).length !== 2) throw new Error("DEC05_LIFT_ANCHOR_NOT_FOUND");
  return { ...r, format: "module", source: text.replace(LOCK, "export const MP_PHASE1_CHECKOUT_ENABLED=true;") };
}
