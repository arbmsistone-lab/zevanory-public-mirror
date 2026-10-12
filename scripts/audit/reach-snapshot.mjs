// Read-only reach snapshot: audience per channel + site funnel by source.
// Prints one JSON line (also as a single annotation, the API keeps few per step).
import { getYoutubeAccessToken } from "../channels/youtube-access.mjs";
const out = { at: new Date().toISOString() };
const j = async (u, o) => { const r = await fetch(u, { ...o, signal: AbortSignal.timeout(15000) }); return r.ok ? r.json() : { _http: r.status }; };
try { const p = await j("https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=zevanoryoficial.bsky.social"); out.bluesky = { followers: p.followersCount, posts: p.postsCount }; } catch (e) { out.bluesky = String(e.message); }
try { const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHANNEL_ID; const r = await j(`https://api.telegram.org/bot${t}/getChatMemberCount?chat_id=${encodeURIComponent(c)}`); out.telegram = { members: r.result ?? r._http }; } catch (e) { out.telegram = "unavailable"; }
try {
  const token = await getYoutubeAccessToken();
  const a = { headers: { authorization: "Bearer " + token } };
  const ch = await j("https://www.googleapis.com/youtube/v3/channels?part=statistics,contentDetails&mine=true", a);
  const st = ch.items?.[0]?.statistics || {}; out.youtube = { subscribers: Number(st.subscriberCount), views: Number(st.viewCount), videos: Number(st.videoCount) };
  const up = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  const pl = await j(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=20&playlistId=${up}`, a);
  const ids = (pl.items || []).map(x => x.contentDetails.videoId).join(",");
  if (ids) { const v = await j(`https://www.googleapis.com/youtube/v3/videos?part=statistics,status,snippet&id=${ids}`, a); out.youtube.recent = (v.items || []).map(x => ({ t: x.snippet.title.slice(0, 40), d: x.snippet.publishedAt.slice(0, 10), views: Number(x.statistics.viewCount || 0), privacy: x.status.privacyStatus })); }
} catch (e) { out.youtube = "error:" + String(e.message).slice(0, 60); }
try {
  const { CLOUDFLARE_API_TOKEN: tk, CLOUDFLARE_ACCOUNT_ID: ac, KV_NAMESPACE_ID: ns } = process.env;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ac}/storage/kv/namespaces/${ns}/values/${encodeURIComponent("zpc-funnel:v1:summary")}`, { headers: { authorization: "Bearer " + tk } });
  const s = r.ok ? await r.json() : null;
  out.site = s ? { last7: s.last7Days, sources: s.sources || null, topCampaigns: (s.topCampaigns || []).slice(0, 5), pages: Object.fromEntries(Object.entries(s.pages || {}).sort((a, b) => (b[1].views || 0) - (a[1].views || 0)).slice(0, 12).map(([k, v]) => [k, v.views || 0])) } : { http: r.status };
} catch (e) { out.site = "error"; }
console.log("::notice title=REACH_SNAPSHOT::" + JSON.stringify(out));
