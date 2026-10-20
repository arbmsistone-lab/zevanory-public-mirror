// Economia de transferência do banco (raiz do incidente Neon de 15/10: 5 GB/mês do plano Free estourados).
// Com as vendas CONFIRMADAMENTE fechadas e sem pedido de abertura, as tarefas de cron que consultam o banco rodam 4x por
// dia (00h, 06h, 12h e 18h UTC, primeiro tique da hora) em vez de 48x. Só pula com informação confiável: vendas abertas,
// pedido de abertura, autorização, falha ao ler o KV (o readSalesSwitch converte erro em "fechado"; contestação D1 do
// Sol, Ordem 008), KV ausente ou qualquer exceção => executa como antes. Retorna o motivo do salto, ou null para executar.
export const SALES_SWITCH_KEY = "sales:open:v1";

export async function dbEconomySkip(normalized, controller, { readSwitch, isOpen, resetCache } = {}) {
  if (typeof readSwitch !== "function" || typeof isOpen !== "function") return null;
  // 1. Prova de que o KV responde: leitura direta da chave do interruptor. Chave ausente (null) é leitura válida
  //    (interruptor nunca aberto); exceção ou binding ausente não é.
  const kv = normalized?.ZEVANORY_PRIVATE_ARTIFACTS;
  if (!kv || typeof kv.get !== "function") return null;
  let raw;
  try { raw = await kv.get(SALES_SWITCH_KEY); } catch { return null; }
  //    A decisão de "fechado" vem desta leitura bruta, não do readSalesSwitch (que trata erro como fechado): uma falha
  //    transitória na leitura interna dele não pode, sozinha, produzir um salto.
  if (raw !== null && raw !== undefined) {
    let parsed;
    try { parsed = JSON.parse(String(raw)); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || parsed.enabled !== false && parsed.enabled !== undefined) return null;
    if (parsed.enabled === true || parsed.requested === true || parsed.authorized === true) return null;
  }
  // 2. Estado semântico (validação da autorização do proprietário fica no readSalesSwitch).
  let state;
  try { if (typeof resetCache === "function") resetCache(); state = await readSwitch(normalized); } catch { return null; }
  if (!state || typeof state !== "object") return null;
  try { if (isOpen(state) || state.enabled === true || state.requested === true || state.authorized === true) return null; } catch { return null; }
  const at = new Date(Number(controller?.scheduledTime) || Date.now());
  if (at.getUTCHours() % 6 === 0 && at.getUTCMinutes() < 30) return null;
  return "vendas_fechadas_economia_banco";
}
