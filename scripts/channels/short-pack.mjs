// Renders the next N days of Shorts (same plan, voice and layout as the daily
// job) into a pack for platforms whose own scheduler must be used — TikTok does
// not allow API posting by tools that publish only to the operator's own account.
// Output: /tmp/short-pack/<YYYY-MM-DD>.mp4 + legendas.txt (caption per day).
// Usage: node short-pack.mjs [--start=YYYY-MM-DD] [--days=10]
// P05 two-phase (AVAL 100): --phase=render (default) renders, gates and stores IMMUTABLE candidates (sha256,
// write-once) and hosts NOTHING; --phase=publish --candidates=<sha,...> materialises exactly the stored,
// human-approved bytes (hash re-verified, no re-render) for hosting and the executor command. A video that does not
// pass the gate is left out; a publish phase with zero approved candidates fails the job.
import { mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { planSlot, renderShort, localDay, avGateSealed, storeCandidate, loadApprovedCandidate, sealApproved, cloudflareKv, fsCandidateStore } from "./youtube-daily-short.mjs";
import { captionFor } from "./short-crosspost.mjs";
const arg = n => (process.argv.find(a => a.startsWith("--" + n + "=")) || "").split("=")[1];
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// TikTok cadence: the value tip at 12:00 and the offer at 19:00 every day.
export const PACK_SLOTS = Object.freeze([["dica", "12:00"], ["oferta", "19:00"]]);
const mediaId = (day, slot) => slot === "oferta" ? day : day + "-" + slot;
export async function buildPack({ start = addDays(localDay(), 1), days = 10, out = "/tmp/short-pack", render = renderShort, store = null } = {}) {
  await mkdir(out, { recursive: true });
  const lines = [], produced = new Set(), rejected = [], candidates = {};
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
      if (store && r.bytes) candidates[mediaId(day, slot)] = (await storeCandidate(store, { bytes: r.bytes, plan: { ...plan, caption_tiktok: captionFor(plan, "tiktok") }, report: r.gate, gateReportBytes: r.gateReportBytes, manifestSha: r.manifestSha })).bundleSha;
      lines.push(`===== ${day} · ${time} =====\nArquivo: ${mediaId(day, slot)}.mp4 (${Math.round(r.duration)} s, voz: ${r.voice})${candidates[mediaId(day, slot)] ? " · bundle sha256 " + candidates[mediaId(day, slot)] + " (aguarda aprovação humana)" : ""}\n\n${captionFor(plan, "tiktok")}\n`);
    }
  }
  await writeFile(`${out}/legendas.txt`, lines.join("\n"));
  await writeFile(`${out}/candidatos.json`, JSON.stringify(candidates, null, 1));
  return { lines: lines.length, produced: [...produced], rejected, candidates };
}
// Phase 2 of the pack: only stored, hash-verified, human-approved bytes become hostable files (+ seal).
export async function materializeApproved(shas, { store, out = "/tmp/short-pack", approvals } = {}) {
  await mkdir(out, { recursive: true });
  const ok = [], refused = [];
  for (const sha of shas) {
    try {
      const c = await loadApprovedCandidate(sha, { store, ...(approvals ? { approvals } : {}) });
      const id = mediaId(c.meta.day, c.meta.slot);
      await sealApproved(`${out}/${id}`, c);
      ok.push({ id, day: c.meta.day, slot: c.meta.slot, sha, caption: c.bundle.caption_tiktok });
    } catch (e) { refused.push(String(sha).slice(0, 12) + ":" + String(e?.message || e).slice(0, 80)); }
  }
  return { ok, refused };
}
const br = d => d.slice(8, 10) + "/" + d.slice(5, 7);
// The ready-to-paste instruction for the browser executor (TikTok Studio has no
// API for own-account tools). ZEVANORY generates and e-mails it with every pack,
// so nobody has to rebuild it by hand.
export function executorCommandFromApproved(items) {
  const time = Object.fromEntries(PACK_SLOTS);
  const sorted = [...items].sort((a, b) => (a.day + time[a.slot]).localeCompare(b.day + time[b.slot]));
  return [
    "AUTORIZAÇÃO DO RENAN: execute tudo sozinho; chame o Renan só para login/2FA ou se a janela do Chrome precisar ficar visível.",
    "", `TAREFA: agendar ${sorted.length} vídeos APROVADOS da ZEVANORY no TikTok Studio (conta @zevanory) nos horários indicados (Brasília). Nunca publique na hora.`,
    "", "1) BAIXAR para Downloads:", ...sorted.map(x => `https://zevanory.api.br/media/short/${x.id}.mp4`),
    "", "2) AGENDAR em https://www.tiktok.com/tiktokstudio/upload, um por vez; rótulo \"Conteúdo gerado por IA\" ativado; legenda = bloco abaixo, exatamente:",
    "", ...sorted.map(x => `--- ${br(x.day)} às ${time[x.slot]} · arquivo ${x.id}.mp4 ---\n${x.caption || ""}`),
    "", "3) Apague de Downloads os vídeos depois de agendados.", "4) RELATÓRIO: os agendamentos com data e hora, e qualquer erro com a mensagem exata.",
  ].join("\n");
}
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
  const phase = arg("phase") || "render";
  const store = process.env.CLOUDFLARE_API_TOKEN ? cloudflareKv({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, namespace: process.env.KV_NAMESPACE_ID }) : fsCandidateStore(process.env.AV_GATE_CANDIDATES || "/tmp/zevanory-candidates");
  if (phase === "publish") {
    const shas = String(arg("candidates") || "").split(",").filter(Boolean);
    const m = await materializeApproved(shas, { store, out });
    for (const f of (await readdir(out)).filter(f => f.endsWith(".mp4"))) if (!(await avGateSealed(`${out}/${f}`))) await rm(`${out}/${f}`);
    const days = [...new Set(m.ok.map(x => x.day))].sort();
    // executor command from the PERSISTED, approved bundles only (captions are never recomputed in this phase)
    if (days.length) await writeFile(`${out}/comando-executor.txt`, executorCommandFromApproved(m.ok));
    console.log(`::notice title=SHORT_PACK::publish phase: ${m.ok.length} approved candidates materialised, refused=${JSON.stringify(m.refused)}`);
    if (!m.ok.length) { console.log("::error title=SHORT_PACK::no human-approved candidate — nothing to host (fail-closed)"); process.exit(1); }
  } else {
    const r = await buildPack({ out, store, start: arg("start") || undefined, days: Math.min(14, Math.max(1, Number(arg("days") || 10))) });
    // Render phase hosts nothing: remove any MP4 at the top level (only sealed, approved bytes may ever be hosted).
    for (const f of (await readdir(out)).filter(f => f.endsWith(".mp4"))) await rm(`${out}/${f}`);
    console.log(`::notice title=SHORT_PACK::render phase: ${r.produced.length} technical-pass candidates stored (pending human approval), ${r.rejected.length} left out; candidates=${JSON.stringify(r.candidates)}`);
    if (!r.produced.length) { console.log("::error title=SHORT_PACK::no video passed zevanory-av-gate (fail-closed)"); process.exit(1); }
  }
}
