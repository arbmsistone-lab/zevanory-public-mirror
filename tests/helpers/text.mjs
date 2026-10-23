// Leitura canônica de TEXTO para testes (AVAL Sol 081, #865).
// No Windows o checkout padrão (core.autocrlf=true) entrega .yml/.mjs/.json com CRLF; regex e igualdades
// escritas para "\n" passam a falhar só lá. Todo teste que lê texto com fs e aplica regex usa esta função
// (verificado estaticamente por tests/guards/portability.test.mjs). Aceita o mesmo primeiro argumento de
// fs.readFileSync (caminho relativo ao cwd, absoluto ou URL file:).
import { readFileSync } from "node:fs";

export function normalizeEol(text) {
  return String(text).replace(/\r\n/g, "\n");
}

export function readTextNormalized(path) {
  return normalizeEol(readFileSync(path, "utf8"));
}
