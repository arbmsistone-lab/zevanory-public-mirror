// Renders the next N days of Shorts (same plan, voice and layout as the daily
// job) into a pack for platforms whose own scheduler must be used — TikTok does
// not allow API posting by tools that publish only to the operator's own account.
// Output: /tmp/short-pack/<YYYY-MM-DD>.mp4 + legendas.txt (caption per day).
// Usage: node short-pack.mjs [--start=YYYY-MM-DD] [--days=10]
// P05: every video goes through zevanory-av-gate inside renderShort (fail-closed). A video that does not PASS
// (or whose brand voice is unavailable) is left OUT of the pack, out of the hosting step and out of the executor
// command; a pack with zero approved videos fails the job. No silent (anullsrc) video can be produced.
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { planSlot, renderShort, localDay, avGateSealed } from "./youtube-daily-short.mjs";
import { captionFor } from "./short-crosspost.mjs";
const arg = n => (process.argv.find(a => a.startsWith("--" + n + "=")) || "").split("=")[1];
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// TikTok cadence: the value tip at 12:00 and the offer at 19:00 every day.
export const PACK_SLOTS = Object.freeze([["dica", "12:00"], ["oferta", "19:00"]]);
const mediaId = (day, slot) => slot === "oferta" ? day : day + "-" + slot;
export async function buildPack({ start = addDays(localDay(), 1), days = 10, out = "/tmp/short-pack", render = renderShort } = {}) {
  await mkdir(out, { recursive: true });
  const lines = [], produced = new Set(), rejected = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    for (const [slot, time] of PACK_SLOTS) {
      const plan = planSlot(day, slot);
      if (plan.gate.action !== "publish" || plan.gate.compliance !== 100) { lines.push(`${day} ${time} | PULADO (gate)`); continue; }
      let r;
      try { r = await render(plan, `${out}/${mediaId(day, slot)}`); }
      catch (e) {
        const why = String(e?.message || e).replace(/[^a-z0-9_:+.-]/gi, "_").slice(0, 120);
        rejected.push(mediaId(day, slot) + ":" + why);
        lines.push(`${day} ${time} | PULADO (zevanory-av-gate: ${why})`);
        console.log(`::warning title=SHORT_PACK_AV_GATE::${mediaId(day, slot)} not packed (${why})`);
        continue;
      }
      produced.add(mediaId(day, slot));
      lines.push(`===== ${day} · ${time} =====\nArquivo: ${mediaId(day, slot)}.mp4 (${Math.round(r.duration)} s, voz: ${r.voice})\n\n${captionFor(plan, "tiktok")}\n`);
    }
  }
  await writeFile(`${out}/legendas.txt`, lines.join("\n"));
  await writeFile(`${out}/comando-executor.txt`, executorCommand(start, days, produced));
  return { lines: lines.length, produced: [...produced], rejected };
}
const br = d => d.slice(8, 10) + "/" + d.slice(5, 7);
// The ready-to-paste instruction for the browser executor (TikTok Studio has no
// API for own-account tools). ZEVANORY generates and e-mails it with every pack,
// so nobody has to rebuild it by hand.
export function executorCommand(start, days = 10, produced = null) {
  const blocks = [], links = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i);
    for (const [slot, time] of PACK_SLOTS) {
      const plan = planSlot(day, slot);
      if (plan.gate.action !== "publish" || plan.gate.compliance !== 100) continue;
      if (produced && !produced.has(mediaId(day, slot))) continue;  // only videos approved by the av-gate
      links.push(`https://zevanory.api.br/media/short/${mediaId(day, slot)}.mp4`);
      blocks.push(`--- ${br(day)} às ${time} · arquivo ${mediaId(day, slot)}.mp4 ---\n${captionFor(plan, "tiktok")}`);
    }
  }
  const end = addDays(start, days - 1);
  return [
    "AUTORIZAÇÃO DO RENAN: execute tudo sozinho; chame o Renan só para login/2FA ou se a janela do Chrome precisar ficar visível.",
    "",
    `TAREFA: agendar ${blocks.length} vídeos da ZEVANORY no TikTok Studio (conta @zevanory), de ${br(start)} a ${br(end)}: todo dia um às 12:00 e outro às 19:00 (Brasília). Nunca publique na hora.`,
    "",
    "1) BAIXAR para Downloads (teste o primeiro; se não baixar, relate o código e pare):",
    ...links,
    "",
    "2) AGENDAR em https://www.tiktok.com/tiktokstudio/upload, um por vez (a aba precisa estar visível):",
    "- envie o arquivo indicado; Quem pode ver: Todos; Comentários e Reutilização (Duet/Stitch) ativados;",
    '- ative o rótulo "Conteúdo gerado por IA";',
    '- vídeos das 19:00 (material gratuito da marca): ative "Divulgar conteúdo da publicação" → "A tua marca" (não marque "Conteúdo de marca");',
    "- agende na data e hora indicadas; a legenda é o bloco de texto abaixo do cabeçalho, exatamente como está;",
    "- antes de cada um, confira em Publicações se aquele horário já tem vídeo agendado; se tiver, pule (nunca duplique);",
    "",
    ...blocks,
    "",
    "3) Apague de Downloads os vídeos depois de agendados.",
    "4) RELATÓRIO: os agendamentos com data e hora, e qualquer erro com a mensagem exata.",
  ].join("\n");
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const out = "/tmp/short-pack";
  const r = await buildPack({ out, start: arg("start") || undefined, days: Math.min(14, Math.max(1, Number(arg("days") || 10))) });
  // Defence in depth: drop any top-level MP4 that is not sealed by a PASS of the gate for exactly its bytes.
  for (const f of (await readdir(out)).filter(f => f.endsWith(".mp4"))) if (!(await avGateSealed(`${out}/${f}`))) await rm(`${out}/${f}`);
  console.log(`::notice title=SHORT_PACK::${r.produced.length} videos approved by zevanory-av-gate, ${r.rejected.length} left out`);
  if (!r.produced.length) { console.log("::error title=SHORT_PACK::no video passed zevanory-av-gate — nothing to host (fail-closed)"); process.exit(1); }
}
