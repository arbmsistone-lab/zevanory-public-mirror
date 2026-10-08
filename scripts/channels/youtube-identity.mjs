// Read-only identity proof: OAuth refresh works and resolves exactly the ZEVANORY channel.
const TARGET = "UCMl8-SxMVv77S2tz2H63P3A";
const out = (level, code) => { console.log(`::${level} title=YOUTUBE_IDENTITY::${code}`); };
try {
  for (const n of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]) if (!process.env[n]) throw Error("missing_secret_" + n);
  const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET, refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, grant_type: "refresh_token" }) });
  const tj = await t.json().catch(() => ({}));
  if (!t.ok || !tj.access_token) throw Error("oauth_http_" + t.status + "_" + String(tj.error || "no_token").replace(/[^a-z_]/gi, ""));
  const scopes = String(tj.scope || "").split(" ").map(s => s.replace("https://www.googleapis.com/auth/", "")).sort().join("+");
  const c = await fetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", { headers: { authorization: "Bearer " + tj.access_token } });
  const cj = await c.json().catch(() => ({}));
  if (!c.ok) throw Error("channels_http_" + c.status);
  const items = cj.items || [];
  if (items.length !== 1 || items[0].id !== TARGET) throw Error("channel_id_mismatch_count_" + items.length);
  out("notice", `channel_id=${items[0].id} custom_url=${items[0].snippet?.customUrl || ""} scopes=${scopes} oauth=PASS`);
} catch (e) { out("error", String(e.message).slice(0, 140)); process.exit(1); }
