// Economia de transferência do banco (raiz do incidente Neon de 15/10: 5 GB/mês do plano Free estourados).
// Só pula com PROVA POSITIVA de vendas fechadas (contestações do Sol, Ordens 008 e 009): UMA leitura bruta da chave
// do interruptor, que precisa existir, ser JSON objeto, ter enabled === false explícito e não ter pedido nem
// autorização. Não depende do readSalesSwitch (que converte erro em "fechado"). Exceção, KV ausente, chave ausente,
// valor ilegível ou qualquer outro formato => executa como antes. Com prova positiva, as tarefas de cron que
// consultam o banco rodam 4x por dia (00h, 06h, 12h e 18h UTC, primeiro tique da hora) em vez de 48x.
export const SALES_SWITCH_KEY = "sales:open:v1";

export function closedProven(raw) {
  if (raw === null || raw === undefined) return false;
  let p;
  try { p = JSON.parse(String(raw)); } catch { return false; }
  if (!p || typeof p !== "object" || Array.isArray(p)) return false;
  return p.enabled === false && p.requested !== true && p.authorized !== true;
}

export async function dbEconomySkip(normalized, controller) {
  const kv = normalized?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv || typeof kv.get !== "function") return null;
  let raw;
  try { raw = await kv.get(SALES_SWITCH_KEY); } catch { return null; }
  if (!closedProven(raw)) return null;
  const at = new Date(Number(controller?.scheduledTime) || Date.now());
  if (at.getUTCHours() % 6 === 0 && at.getUTCMinutes() < 30) return null;
  return "vendas_fechadas_economia_banco";
}
