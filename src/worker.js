// Capture website worker
// - Serves the static site (index.html) as before
// - /api/instagram returns the latest Instagram posts of @bycapture_
// - Keeps the Instagram token alive by refreshing it automatically (stored in KV)

const POSTS = 9;            // number of posts shown on the site
const CACHE_SECONDS = 3600; // refresh the posts list every hour
const REFRESH_DAYS = 7;     // renew the token every 7 days (it expires after 60)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/instagram") {
      return instagram(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function getToken(env, ctx) {
  let token = env.IG_TOKEN;
  if (!env.IG_KV) return token;

  const saved = await env.IG_KV.get("token", "json");
  if (saved && saved.token) token = saved.token;
  if (!token) return null;

  const age = saved ? Date.now() - saved.at : Infinity;
  if (age > REFRESH_DAYS * 86400000) {
    ctx.waitUntil(refreshToken(env, token));
  }
  return token;
}

async function refreshToken(env, token) {
  try {
    const r = await fetch(
      "https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=" +
        encodeURIComponent(token)
    );
    const d = await r.json();
    if (d.access_token) {
      await env.IG_KV.put("token", JSON.stringify({ token: d.access_token, at: Date.now() }));
    }
  } catch (e) {
    // keep the current token; we will try again on a later request
  }
}

async function instagram(request, env, ctx) {
  const cache = caches.default;
  const key = new Request(new URL("/api/instagram", request.url).toString());
  const hit = await cache.match(key);
  if (hit) return hit;

  const token = await getToken(env, ctx);
  if (!token) return json({ posts: [], error: "missing token" }, 503, 60);

  const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
  const api =
    "https://graph.instagram.com/me/media?fields=" + fields +
    "&limit=" + POSTS + "&access_token=" + encodeURIComponent(token);

  let data;
  try {
    const r = await fetch(api);
    data = await r.json();
    if (!r.ok || !data.data) throw new Error((data.error && data.error.message) || "bad response");
  } catch (e) {
    return json({ posts: [], error: "instagram unavailable" }, 502, 60);
  }

  const posts = data.data
    .map((p) => ({
      image: p.media_type === "VIDEO" ? p.thumbnail_url : p.media_url,
      link: p.permalink,
      caption: p.caption || "",
      video: p.media_type === "VIDEO",
      date: p.timestamp,
    }))
    .filter((p) => p.image);

  const res = json({ posts }, 200, CACHE_SECONDS);
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=" + maxAge,
    },
  });
}
