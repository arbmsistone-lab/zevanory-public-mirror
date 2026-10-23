// Pré-checagem de ferramentas externas para testes (AVAL Sol 081, #865).
// Um teste que executa python3, jq ou bash chama requireTool() ANTES de usá-los: se a ferramenta não existe
// no PATH (ou é o atalho da Microsoft Store que sai 9009), o teste FALHA com "TOOL_MISSING: <tool>" em vez
// de uma asserção confusa (status null, stderr vazio, JSON inválido). Nunca pula: ausência é falha explícita.
import { spawnSync } from "node:child_process";

export function toolStatus(tool, args = ["--version"]) {
  const r = spawnSync(tool, args, { encoding: "utf8", windowsHide: true });
  if (r.error) return { ok: false, reason: r.error.code || String(r.error.message) };
  if (r.status !== 0) return { ok: false, reason: `exit ${r.status}` };
  return { ok: true, version: String(r.stdout || r.stderr).split(/\r?\n/)[0] };
}

export function requireTool(tool, args) {
  const s = toolStatus(tool, args);
  if (!s.ok) throw new Error(`TOOL_MISSING: ${tool} (${s.reason}); instale ${tool} no PATH para rodar este teste`);
  return s.version;
}
