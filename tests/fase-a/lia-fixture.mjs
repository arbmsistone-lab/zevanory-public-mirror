// P01 Fase A (AVAL 099 §2): LIA APROVADA SINTÉTICA, só para testes. Nunca é escrita no repositório nem vira
// configuração: deriva do texto real da LIA trocando o marcador de pendência e preenchendo a tabela de aprovação.
import { liaText, liaSha256, buildManifest } from "../../scripts/fase_a/lia_manifest.mjs";

export const REAL_LIA_TEXT = liaText();
export const PENDING_ROW = /^\| _pendente_ \| _pendente_ \| _pendente_ \| _pendente_ \|.*$/m;
export function approvedText(text = REAL_LIA_TEXT, row = "| Revisora Sintética de Teste | 2026-10-24 | 1 | APROVADA | fixture de teste, não é aprovação real |") {
  if (!PENDING_ROW.test(text)) throw new Error("linha pendente não encontrada na LIA");
  return text.replace("PENDENTE DE REVISÃO JURÍDICA", "REVISÃO JURÍDICA CONCLUÍDA (fixture)").replace(PENDING_ROW, row);
}
export async function manifestOf(text) { return Object.freeze(await buildManifest(text)); }
export const APPROVED_TEXT = approvedText();
export const TEST_LIA = await manifestOf(APPROVED_TEXT);
export const TEST_LIA_SHA = liaSha256(APPROVED_TEXT);
