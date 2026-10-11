// Renders the next N days of Shorts (same plan, voice and layout as the daily
// job) into a pack for platforms whose own scheduler must be used — TikTok does
// not allow API posting by tools that publish only to the operator's own account.
// Output: /tmp/short-pack/<YYYY-MM-DD>.mp4 + legendas.txt (caption per day).
// Usage: node short-pack.mjs [--start=YYYY-MM-DD] [--days=10]
import { mkdir, writeFile } from "node:fs/promises";
import { planShort, renderShort, localDay } from "./youtube-daily-short.mjs";
import { captionFor } from "./short-crosspost.mjs";
const arg = n => (process.argv.find(a => a.startsWith("--" + n + "=")) || "").split("=")[1];
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export async function buildPack({ start = addDays(localDay(), 1), days = 10, out = "/tmp/short-pack", render = renderShort } = {}) {
  await mkdir(out, { recursive: true });
  const lines = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(start, i), plan = planShort(day);
    if (plan.gate.action !== "publish" || plan.gate.compliance !== 100) { lines.push(`${day} | PULADO (não passou no gate de qualidade)`); continue; }
    const r = await render(plan, `${out}/${day}`);
    lines.push(`===== ${day} · publicar às 12:00 =====\nArquivo: ${day}.mp4 (${Math.round(r.duration)} s, voz: ${r.voice})\n\n${captionFor(plan, "tiktok")}\n`);
  }
  await writeFile(`${out}/legendas.txt`, lines.join("\n"));
  return lines.length;
}
const isMain = process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href;
if (isMain) {
  const n = await buildPack({ start: arg("start") || undefined, days: Math.min(14, Math.max(1, Number(arg("days") || 10))) });
  console.log(`::notice title=SHORT_PACK::${n} days rendered`);
}
