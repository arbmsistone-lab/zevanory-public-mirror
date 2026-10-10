import { getYoutubeAccessToken } from "./youtube-access.mjs";
// Read-only identity proof: OAuth refresh works and resolves exactly the ZEVANORY channel.
const TARGET = "UCMl8-SxMVv77S2tz2H63P3A";
const out = (level, code) => { console.log(`::${level} title=YOUTUBE_IDENTITY::${code}`); };
try {
  for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"]) if (!process.env[n]) throw Error("missing_secret_" + n);
  const accessToken = await getYoutubeAccessToken();
  const c = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers: { authorization: "Bearer " + accessToken } });
  const cj = await c.json().catch(() => ({}));
  if (!c.ok) throw Error("channels_http_" + c.status);
  const items = cj.items || [];
  if (items.length !== 1 || items[0].id !== TARGET) throw Error("channel_id_mismatch_count_" + items.length);
  out("notice", `channel_id=${items[0].id} custom_url=${items[0].snippet?.customUrl || ""} scopes=${scopes} oauth=PASS`);
} catch (e) { out("error", String(e.message).slice(0, 140)); process.exit(1); }
