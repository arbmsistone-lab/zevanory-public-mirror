import { getYoutubeAccessToken } from "./youtube-access.mjs";
// Private proof upload (issue: YouTube plan step 3). Uploads ONE private video built and
// gated by youtube-preflight.mjs, is idempotent across retries, polls until processing ends,
// and stops. It never changes visibility and never enables automation.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const TARGET = "UCMl8-SxMVv77S2tz2H63P3A";
const base = "/tmp/zevanory-youtube-preflight";
const note = (level, code) => console.log(`::${level} title=YOUTUBE_PROOF::${code}`);
const fail = code => { throw Error(code); };
try {
  const report = JSON.parse(await readFile(base + ".json", "utf8"));
  if (report.technicalCheck !== "PASS" || report.gate?.decision !== "approved_for_autopublish" || report.gate?.compliance !== 100 || !(report.gate?.score >= 85)) fail("preflight_not_approved");
  const mp4 = await readFile(base + ".mp4");
  const proofKey = createHash("sha256").update(`${report.gate.creative_id}|proof-v1`).digest("hex").slice(0, 16);
  const marker = `zevanory-proof-key:${proofKey}`;
  const accessToken = await getYoutubeAccessToken();
  const auth = { authorization: "Bearer " + accessToken };
  const ch = await (await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&mine=true", { headers: auth })).json();
  if (ch.items?.length !== 1 || ch.items[0].id !== TARGET) fail("channel_id_mismatch");
  // Idempotency: reuse a previous proof carrying the same key instead of uploading again.
  const uploads = ch.items[0].contentDetails?.relatedPlaylists?.uploads;
  let videoId = "";
  if (uploads) {
    const pl = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(uploads)}`, { headers: auth })).json();
    videoId = (pl.items || []).find(i => String(i.snippet?.description || "").includes(marker))?.snippet?.resourceId?.videoId || "";
  }
  const reused = Boolean(videoId);
  if (!reused) {
    const metadata = {
      snippet: { title: "ZEVANORY · IA prática, com clareza", description: `IA prática para organizar tarefas repetitivas com clareza. Garantia de 7 dias.\nSaiba mais: https://zevanory.api.br/?utm_source=youtube&utm_medium=organic&utm_campaign=proof_v1\n\n${marker}`, tags: ["ZEVANORY", "IA prática", "automação"], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true }
    };
    const start = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { ...auth, "content-type": "application/json; charset=utf-8", "x-upload-content-type": "video/mp4", "x-upload-content-length": String(mp4.length) }, body: JSON.stringify(metadata) });
    if (!start.ok || !start.headers.get("location")) fail("resumable_start_http_" + start.status);
    const put = await fetch(start.headers.get("location"), { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(mp4.length) }, body: mp4 });
    const pj = await put.json().catch(() => ({}));
    if (!put.ok || !pj.id) fail("upload_http_" + put.status);
    videoId = pj.id;
  }
  // Poll until YouTube finishes processing (max ~15 min).
  let v = null;
  for (let i = 0; i < 45; i++) {
    const r = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${videoId}`, { headers: auth })).json();
    v = r.items?.[0];
    const ps = v?.processingDetails?.processingStatus, us = v?.status?.uploadStatus;
    if (ps === "succeeded" || ps === "failed" || ps === "terminated" || us === "processed" || us === "rejected" || us === "failed") break;
    await new Promise(r => setTimeout(r, 20000));
  }
  if (!v) fail("video_lookup_failed");
  const summary = { video_id: videoId, url: `https://youtu.be/${videoId}`, studio: `https://studio.youtube.com/video/${videoId}/edit`, reused_existing_proof: reused, upload_status: v.status?.uploadStatus, processing_status: v.processingDetails?.processingStatus || "", privacy_status: v.status?.privacyStatus, rejection_reason: v.status?.rejectionReason || "", failure_reason: v.status?.failureReason || "", gate: report.gate, tts: report.tts, automation: "disabled" };
  note("notice", JSON.stringify(summary));
  if (summary.privacy_status !== "private") fail("privacy_not_private_" + summary.privacy_status);
  if (summary.upload_status !== "processed") fail("not_processed_" + summary.upload_status + "_" + summary.processing_status);
  note("notice", "PROOF_COMPLETE_STOPPED_AWAITING_OWNER_REVIEW");
} catch (e) { note("error", String(e.message).replace(/[^a-z0-9_:.-]/gi, "_").slice(0, 140)); process.exit(1); }
