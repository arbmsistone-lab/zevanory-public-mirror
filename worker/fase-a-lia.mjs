// P01 Fase A (AVAL 099 §2): trava técnica FAIL-CLOSED que amarra a ATIVAÇÃO da medição à versão
// juridicamente aprovada da LIA (docs/lgpd/LIA-fase-a.md).
// * O Worker não lê o repositório: o manifesto da LIA (sha256 do conteúdo, versão, marcador de pendência e a
//   linha de aprovação) é gerado por scripts/fase_a/lia_manifest.mjs em worker/fase-a-lia.generated.mjs e o CI
//   (tests/fase-a/waitlist-rule.test.mjs) falha se ele divergir do documento. Editar a LIA muda o sha256.
// * A medição só fica ATIVA se TODAS as condições valerem:
//   1. manifesto válido (sha256 hex de 64);
//   2. LIA sem marcador de pendência ("PENDENTE DE REVISÃO JURÍDICA" ou "_pendente_");
//   3. tabela "## Aprovação" com uma linha completa: revisor (nome), data AAAA-MM-DD válida, versão igual à
//      "Versão: N" do documento e decisão "APROVADA";
//   4. env FASE_A_LIA_APPROVED_SHA256 (definida pelo proprietário, NUNCA por automação) igual ao sha256 do
//      conteúdo aprovado. LIA editada depois da aprovação => sha256 novo => divergente => desligada até nova
//      aprovação.
// * Qualquer falha: endpoints de medição recusam com 503 sem cookie e sem gravar nada; /saude informa o motivo.
// Hash: SHA-256 do texto UTF-8 com fins de linha normalizados para LF.
import { LIA_FASE_A } from "./fase-a-lia.generated.mjs";

export const LIA_PATH = "docs/lgpd/LIA-fase-a.md";
export const LIA_PENDING_MARKERS = Object.freeze(["PENDENTE DE REVISÃO JURÍDICA", "_pendente_"]);
const SHA_RE = /^[0-9a-f]{64}$/;
const ISO_DATE = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

// Linha de aprovação válida: | Revisor | Data | Versão da LIA | Decisão | Observações |
export function approvalComplete(approval, version) {
  if (!approval || typeof approval !== "object") return false;
  const name = String(approval.reviewer || "").trim();
  if (name.length < 3 || /pendente|_/i.test(name)) return false;
  if (!ISO_DATE(String(approval.date || ""))) return false;
  if (!Number.isInteger(version) || Number(approval.version) !== version) return false;
  return String(approval.decision || "").trim() === "APROVADA";
}

// Lê a LIA (texto) e devolve versão, marcador de pendência e a primeira linha de aprovação completa (ou null).
export function parseLia(text) {
  const t = String(text || "").replace(/\r\n/g, "\n");
  const vm = /Versão:\s*(\d+)/.exec(t);
  const version = vm ? Number(vm[1]) : null;
  const pending_marker = LIA_PENDING_MARKERS.some((m) => t.includes(m));
  const sec = t.split(/^## Aprovação\s*$/m)[1] || "";
  let approval = null;
  for (const line of sec.split("\n")) {
    if (/^## /.test(line)) break;
    if (!/^\|.*\|\s*$/.test(line) || /^\|\s*-/.test(line)) continue;
    const c = line.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
    if (c[0] === "Revisor") continue;
    const row = { reviewer: c[0] || "", date: c[1] || "", version: c[2] === undefined ? null : Number(c[2]), decision: c[3] || "" };
    if (approvalComplete(row, version)) { approval = row; break; }
  }
  return { version, pending_marker, approval };
}

export function liaActivation(env, lia = LIA_FASE_A) {
  const sha = String(lia?.sha256 || "");
  const base = { active: false, reason: null, lia_path: LIA_PATH, lia_sha256: SHA_RE.test(sha) ? sha : null, lia_version: lia?.version ?? null, approved_sha256_configured: false };
  if (!SHA_RE.test(sha)) return { ...base, reason: "lia_manifesto_invalido" };
  if (lia.pending_marker !== false) return { ...base, reason: "lia_pendente_de_revisao" };
  if (!approvalComplete(lia.approval, lia.version)) return { ...base, reason: "lia_aprovacao_incompleta" };
  const want = String(env?.FASE_A_LIA_APPROVED_SHA256 || "").trim().toLowerCase();
  if (!want) return { ...base, reason: "aprovacao_nao_configurada" };
  if (!SHA_RE.test(want)) return { ...base, approved_sha256_configured: true, reason: "aprovacao_formato_invalido" };
  if (want !== sha) return { ...base, approved_sha256_configured: true, reason: "lia_alterada_apos_aprovacao" };
  return { ...base, approved_sha256_configured: true, active: true };
}
