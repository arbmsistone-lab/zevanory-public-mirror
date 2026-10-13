// Trust-chain projection for /api/control-plane when the snapshot carries no canonical trust_chain.
//
// P0 (false TRUST CHAIN GREEN): the old projection answered "GREEN" from the legacy policy alone
// (commercial enabled + 10 proven + zea10 live), while reporting passed 0/0, required 0,
// independent_keys 0, quorum_available false and no evidence root. The panel painted that GREEN
// as healthy next to "Quorum 0/0 · mínimo 0". A trust chain without an independent quorum is not
// verified, so this projection can never say GREEN. Only a canonical trust_chain with a proven
// quorum (produced elsewhere) may be GREEN; see quorumProven().
export const MIN_INDEPENDENT_QUORUM = 2;

export function quorumProven(t) {
  if (!t || typeof t !== "object") return false;
  const passed = Number(t.passed) || 0;
  const required = Number(t.required) || 0;
  const keys = Number(t.independent_keys) || 0;
  const conflicts = Number(t.conflicts) || 0;
  return required >= MIN_INDEPENDENT_QUORUM && passed >= required && keys >= required && conflicts === 0
    && typeof t.evidence_root === "string" && t.evidence_root.length > 0;
}

// A canonical trust_chain that claims GREEN without the quorum behind it is demoted, never trusted.
export function guardTrustChain(t) {
  if (!t || typeof t !== "object") return t;
  if (t.state === "GREEN" && !quorumProven(t)) return { ...t, state: "UNVERIFIED", reason: "green_without_proven_quorum" };
  return t;
}

export function legacyTrustProjection(body) {
  // Proven count: the canonical ZEA-10 evaluation (zea10_live.report, bound to this release) wins
  // over the legacy `policy` block, which the worker itself marks deprecated_for_decision. On 13/10
  // the legacy block said 0/10 while the canonical evaluation and the Control Core said 10/10,
  // making this route BLOCKED against a core ALLOW (owner audit, Mission 1). The legacy block is
  // used only when no canonical report exists. The ceiling is still UNVERIFIED (never GREEN).
  const canonical = body?.zea10_live?.report;
  const releaseSha = body?.release?.deployment?.commit_sha || body?.proof_chain?.sha || null;
  const canonicalCounts = canonical?.counts && typeof canonical.counts === "object" ? canonical.counts : null;
  const lc = (v) => String(v || "").trim().toLowerCase();
  // Bound only when both SHAs exist and match: an unbound report never counts (independent review).
  const canonicalBound = Boolean(canonicalCounts && releaseSha && canonical?.release_sha && lc(canonical.release_sha) === lc(releaseSha));
  const counts = canonicalCounts || body?.policy?.counts || {};
  const totalProven = Number(counts.proven || 0);
  const noneOpen = !canonicalCounts || (Number(counts.partial || 0) === 0 && Number(counts.blocked || 0) === 0 && Number(counts.unknown || 0) === 0);
  const liveReady = body?.zea10_live?.ready === true;
  const liveFailClosed = body?.zea10_live?.fail_closed !== false;
  const commercialEnabled = body?.global_state === "operational_commercial_enabled";
  const legacyOk = commercialEnabled && totalProven === 10 && noneOpen && (!canonicalCounts || canonicalBound) && liveReady && !liveFailClosed;

  return {
    // UNVERIFIED: the legacy indicators agree, but nothing independent confirmed them.
    state: legacyOk ? "UNVERIFIED" : "BLOCKED",
    reason: legacyOk ? "legacy_indicators_only_no_independent_quorum" : "legacy_indicators_not_met",
    artifact_sha: body?.proof_chain?.sha
      || body?.policy?.release_sha
      || body?.release?.deployment?.commit_sha
      || null,
    evidence_root: null,
    policy_version: body?.policy?.framework || "ZEA-10",
    passed: 0,
    total: 0,
    required: MIN_INDEPENDENT_QUORUM,
    conflicts: 0,
    independent_keys: 0,
    engines: [
      {
        id: "zea10-live",
        state: liveReady ? (liveFailClosed ? "FAIL_CLOSED" : "GREEN") : "UNAVAILABLE"
      }
    ],
    ledger: {
      checked_at: body?.zea10_live?.report?.generated_at
        || body?.zea10_live?.report?.checked_at
        || null
    },
    compatibility: {
      source: "control-plane-vnext",
      quorum_available: false,
      claim_scope: body?.policy?.claim_scope || "internal_engineering_alignment_not_external_certification"
    }
  };
}
