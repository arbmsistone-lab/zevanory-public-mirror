// B07 T4 (classe B — toca o Worker): identidade NÃO secreta do banco para conferência externa.
// Os segredos do Worker são só escrita na Cloudflare; para provar que o DATABASE_URL do Worker aponta para o
// zevanory-db-2 sem expô-lo, /api/health publica apenas sha256 do HOST normalizado: minúsculas, sem ponto final e
// sem o sufixo "-pooler" do 1º rótulo (host direto e do pooler do mesmo endpoint Neon dão o mesmo hash). Nunca
// usuário, senha, banco, porta ou parâmetros. Mesma regra de scripts/ops/database_url_inventory.py
// (tests/test_database_url_inventory.py compara os dois com os mesmos vetores falsos).
import { createHash } from "node:crypto";

export function databaseHostSha256(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  const host = String(parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  const dot = host.indexOf(".");
  const first = dot === -1 ? host : host.slice(0, dot);
  const rest = dot === -1 ? "" : host.slice(dot);
  const norm = first.replace(/-pooler$/, "") + rest;
  return createHash("sha256").update(norm).digest("hex");
}
