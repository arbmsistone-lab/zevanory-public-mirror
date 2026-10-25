// P23 Fiscal e consumidor (Roteiro Mestre v4.7, seção 5; seção 7, fase F3): "Nenhuma venda direta pelo checkout
// próprio antes do processo fiscal definido" (PI). Fonte única: data/p23/fiscal-process.json, versionado e conferido
// em CI por scripts/p23/ecommerce_legal_gate.py. O enquadramento é decisão de classe D do proprietário com o contador;
// este módulo não decide nada: só diz se o registro está COMPLETO. Qualquer falta = false (fail-closed).
import FISCAL from "../data/p23/fiscal-process.json" with { type: "json" };

export const FISCAL_PROCESS = Object.freeze(FISCAL);
export const FISCAL_DECISION_FIELDS = Object.freeze(["regime", "documento_fiscal", "emissor", "decided_by", "accountant_ref", "decided_at", "procedure_ref", "test_order_ref", "owner_approval_ref"]);

const filled = (v) => typeof v === "string" && v.trim().length >= 2 && !/PENDENTE|PREENCHER|A CONFIRMAR|XXX|\bTODO\b/.test(v);

export function fiscalProcessDefined(record = FISCAL_PROCESS, now = Date.now()) {
  if (!record || record.status !== "DEFINIDO") return false;
  const d = record.decision;
  if (!d || typeof d !== "object") return false;
  for (const k of FISCAL_DECISION_FIELDS) {
    if (k === "procedure_ref") {
      const r = d.procedure_ref;
      if (!r || r.kind !== "repo" || !filled(r.ref) || !filled(r.contains)) return false;
    } else if (!filled(d[k])) return false;
  }
  if (d.decided_by !== "proprietario") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.decided_at)) return false;
  const at = Date.parse(d.decided_at + "T00:00:00Z");
  return Number.isFinite(at) && at <= now;
}
