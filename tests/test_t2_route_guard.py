"""t2_route_guard: factory/tick must be HMAC-guarded before work, in the inline and the module layout.

Fixtures are synthetic excerpts with the same shape as the control-edge source (the private source is
not copied into this public repository). Every mutant must be rejected with a specific reason.
"""
import importlib.util
import pathlib
import unittest

_SPEC = importlib.util.spec_from_file_location(
    "t2_route_guard", pathlib.Path(__file__).resolve().parents[1] / "scripts" / "deploy" / "t2_route_guard.py")
g = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(g)

ROUTE = """
    if (url.pathname === '/api/commercial/creative/factory/tick') {
      if (request.method !== 'POST') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
      if (!await verifyFactoryRequest(request, env)) return Response.json({ ok: false, error: 'commercial_creative_factory_auth_required' }, { status: 401 });
      try {
        const product = url.searchParams.get('product');
        await doWork(product);
      } catch {}
    }
"""

INLINE_WORKER = """
async function verifyFactoryRequest(request: Request, env: Record<string, unknown>) {
  const secret = String(env.COMMERCIAL_ROBOT_TICK_SECRET || '');
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, bytes, message);
}
""" + ROUTE

MODULE_WORKER = """import { CREATIVE_FACTORY_PURPOSE, operatorTokenMigration, verifyCommercialSignature } from './commercial-hmac.ts';

async function verifyFactoryRequest(request: Request, env: Record<string, unknown>) {
  // R9-D1: candidates live in commercial-hmac.ts.
  return (await verifyCommercialSignature(request.headers, env, CREATIVE_FACTORY_PURPOSE)) !== 'none';
}
""" + ROUTE

MODULE = """
export async function verifyCommercialSignature(
  headers: Headers,
  env: Env,
  purpose: string,
  extra: string[] = [],
  { now = Date.now(), log = console as Logger }: { now?: number; log?: Logger } = {},
): Promise<CommercialAuthResult> {
  const candidates = commercialHmacCandidates(env, now);
  if (!candidates.length) {
    return recordCommercialAuth('none', log);
  }
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_MS) return recordCommercialAuth('none', log);
  let hit: CommercialAuthResult = 'none';
  for (const candidate of candidates) {
    const key = await crypto.subtle.importKey('raw', enc(candidate.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, bytes, message);
    if (ok && hit === 'none') hit = candidate.category;
  }
  return recordCommercialAuth(hit, log);
}

export const CREATIVE_FACTORY_PURPOSE = 'zevanory-commercial-creative-factory-v1';
"""


class Accept(unittest.TestCase):
    def test_inline_layout(self):
        self.assertEqual(g.check(INLINE_WORKER, None), (True, "layout_inline"))

    def test_module_layout(self):
        self.assertEqual(g.check(MODULE_WORKER, MODULE), (True, "layout_module"))


class Mutants(unittest.TestCase):
    def reject(self, worker, module, reason):
        ok, got = g.check(worker, module)
        self.assertFalse(ok)
        self.assertEqual(got, reason)

    def test_route_missing(self):
        self.reject(MODULE_WORKER.replace("factory/tick", "factory/tock"), MODULE, "route_missing")

    def test_route_accepts_get(self):
        self.reject(MODULE_WORKER.replace("if (request.method !== 'POST') return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405 });\n", ""), MODULE, "route_accepts_non_post")

    def test_work_before_auth(self):
        moved = MODULE_WORKER.replace(
            "      if (!await verifyFactoryRequest(request, env)) return Response.json({ ok: false, error: 'commercial_creative_factory_auth_required' }, { status: 401 });\n      try {",
            "      try {\n      if (!await verifyFactoryRequest(request, env)) return Response.json({ ok: false, error: 'commercial_creative_factory_auth_required' }, { status: 401 });")
        self.reject(moved, MODULE, "route_not_authenticated_before_work")

    def test_verifier_always_true(self):
        self.reject(MODULE_WORKER.replace("!== 'none';", "!== 'none' || true;"), MODULE, "verifyFactoryRequest_unrecognised")

    def test_verifier_other_purpose(self):
        self.reject(MODULE_WORKER.replace("env, CREATIVE_FACTORY_PURPOSE)", "env, COMMERCIAL_AUTH_PROBE_PURPOSE)"), MODULE, "verifyFactoryRequest_unrecognised")

    def test_verifier_not_imported(self):
        self.reject(MODULE_WORKER.replace(", verifyCommercialSignature }", " }"), MODULE, "verifyCommercialSignature_not_imported_from_commercial_hmac")

    def test_verifier_imported_elsewhere(self):
        self.reject(MODULE_WORKER.replace("'./commercial-hmac.ts'", "'./fake-hmac.ts'"), MODULE, "verifyCommercialSignature_not_imported_from_commercial_hmac")

    def test_module_missing(self):
        self.reject(MODULE_WORKER, None, "commercial_hmac_missing")

    def test_hit_starts_open(self):
        self.reject(MODULE_WORKER, MODULE.replace("let hit: CommercialAuthResult = 'none';", "let hit: CommercialAuthResult = 'tick';"), "hit_not_initialised_none")

    def test_no_hmac_verify(self):
        self.reject(MODULE_WORKER, MODULE.replace("await crypto.subtle.verify('HMAC', key, bytes, message)", "true"), "no_hmac_verify")

    def test_hit_without_verify(self):
        self.reject(MODULE_WORKER, MODULE.replace("if (ok && hit === 'none')", "if (hit === 'none')"), "hit_set_without_verify")

    def test_returns_constant(self):
        self.reject(MODULE_WORKER, MODULE.replace("return recordCommercialAuth(hit, log);\n}", "return recordCommercialAuth('tick', log);\n}"), "does_not_return_hit")

    def test_extra_assignment(self):
        self.reject(MODULE_WORKER, MODULE.replace("  for (const candidate", "  if (env.DEBUG) hit = 'tick';\n  for (const candidate"), "hit_assigned_elsewhere")

    def test_early_return_open(self):
        self.reject(MODULE_WORKER, MODULE.replace("return recordCommercialAuth('none', log);\n  }", "return recordCommercialAuth('tick', log);\n  }", 1), "early_return_not_none")

    def test_inline_without_verify(self):
        self.reject(INLINE_WORKER.replace("crypto.subtle.verify('HMAC', key, bytes, message)", "true"), None, "verifyFactoryRequest_unrecognised")


if __name__ == "__main__":
    unittest.main()
