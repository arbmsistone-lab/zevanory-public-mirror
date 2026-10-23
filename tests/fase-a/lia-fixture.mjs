// P01 Fase A (AVAL 099 §2 e 101 §3): LIA e ROPA APROVADOS SINTÉTICOS, só para testes. Nunca são escritos no
// repositório nem viram configuração: derivam dos textos reais trocando o marcador de pendência e preenchendo a
// tabela de aprovação (com a versão do próprio documento).
import { liaText, liaSha256, buildManifest, LIA_FILE, ROPA_FILE } from "../../scripts/fase_a/lia_manifest.mjs";

export const REAL_LIA_TEXT = liaText(LIA_FILE);
export const REAL_ROPA_TEXT = liaText(ROPA_FILE);
export const PENDING_ROW = /^\| _pendente_ \| _pendente_ \| _pendente_ \| _pendente_ \|.*$/m;
const versionOf = (t) => Number((/Versão:\s*(\d+)/.exec(t) || [])[1]);
export function approvedText(text = REAL_LIA_TEXT, row = null) {
  if (!PENDING_ROW.test(text)) throw new Error("linha pendente não encontrada");
  const r = row ?? `| Revisora Sintética de Teste | 2026-10-24 | ${versionOf(text)} | APROVADA | fixture de teste, não é aprovação real |`;
  return text.replace("PENDENTE DE REVISÃO JURÍDICA", "REVISÃO JURÍDICA CONCLUÍDA (fixture)").replace(PENDING_ROW, r);
}
export async function manifestOf(text, rel = "docs/lgpd/LIA-fase-a.md") { return Object.freeze(await buildManifest(text, undefined, rel)); }
export const APPROVED_TEXT = approvedText();
export const APPROVED_ROPA_TEXT = approvedText(REAL_ROPA_TEXT);
export const TEST_LIA = await manifestOf(APPROVED_TEXT);
export const TEST_ROPA = await manifestOf(APPROVED_ROPA_TEXT, "docs/lgpd/ROPA-fase-a.md");
export const TEST_LIA_SHA = liaSha256(APPROVED_TEXT);
export const TEST_ROPA_SHA = liaSha256(APPROVED_ROPA_TEXT);
export const TEST_DOCS = Object.freeze({ lia: TEST_LIA, ropa: TEST_ROPA });
export const APPROVED_ENV = Object.freeze({ FASE_A_LIA_APPROVED_SHA256: TEST_LIA_SHA, FASE_A_ROPA_APPROVED_SHA256: TEST_ROPA_SHA });
