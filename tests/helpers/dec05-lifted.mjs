// Tests only. DEC-05 keeps Mercado Pago own-checkout locked in phase one (worker/nc015-sales-scope.mjs), and the lock
// is checked BEFORE the older defences of the checkout path (pilot isolation, sales gate, 303/405 buy flow, exception
// handling). Those defences are what protects production the day the lock is lifted, so they must keep being proven:
// importLifted() loads a fresh copy of a Worker module whose nc015-sales-scope.mjs has the lock lifted, in this process
// only, without touching the source tree or the default (locked) module graph.
import { register } from "node:module";

register("./dec05-lifted-hooks.mjs", import.meta.url);

export async function importLifted(moduleUrl) {
  const u = new URL(moduleUrl);
  u.searchParams.set("zev-dec05-lifted", "1");
  const scope = new URL("../../worker/nc015-sales-scope.mjs", import.meta.url);
  scope.searchParams.set("zev-dec05-lifted", "1");
  const lock = await import(scope.href);
  // Guard: the simulation is only meaningful if the lifted copy really is lifted.
  if (lock.isMpPhase1CheckoutEnabled() !== true) throw new Error("DEC05_LIFT_FAILED");
  return import(u.href);
}
