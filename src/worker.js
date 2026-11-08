import { analyze } from "./analyze.js";

const UA = "Mozilla/5.0 (compatible; NexusBendersCrawlerCheck/1.0; +https://check.nexusbenders.bd)";
const MAX_BYTES = 2_000_000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function normalizeUrl(input) {
  let s = String(input || "").trim();
  if (!s) throw new Error("Enter a URL.");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https URLs work.");
  const h = u.hostname.toLowerCase();
  // Basic SSRF guard: public hostnames only.
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") ||
      /^(\d+\.){3}\d+$/.test(h) || h.includes(":")) {
    throw new Error("Enter a public website address.");
  }
  u.hash = "";
  return u;
}

async function fetchText(url, limit = MAX_BYTES) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
  });
  const reader = res.body?.getReader();
  let received = 0, chunks = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(value);
      if (received > limit) { reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(received);
  let off = 0; for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, received - off)), off); off += c.length; }
  return { status: res.status, finalUrl: res.url, contentType: res.headers.get("content-type") || "", text: new TextDecoder().decode(buf) };
}

async function check(rawUrl) {
  const u = normalizeUrl(rawUrl);
  const page = await fetchText(u.toString());
  if (page.status >= 400) throw new Error(`The site answered with HTTP ${page.status}.`);
  if (!/html/i.test(page.contentType) && !/<html/i.test(page.text)) throw new Error("That address didn't return a web page.");
  const origin = new URL(page.finalUrl || u).origin;
  const [robots, sitemap] = await Promise.allSettled([
    fetchText(origin + "/robots.txt", 200_000),
    fetchText(origin + "/sitemap.xml", 200_000),
  ]);
  const robotsTxt = robots.status === "fulfilled" && robots.value.status === 200 && !/<html/i.test(robots.value.text) ? robots.value.text : "";
  let hasSitemap = sitemap.status === "fulfilled" && sitemap.value.status === 200 && /<(urlset|sitemapindex)/i.test(sitemap.value.text);
  if (!hasSitemap && /^\s*sitemap:/im.test(robotsTxt)) hasSitemap = true;
  return analyze({ url: u.toString(), finalUrl: page.finalUrl, status: page.status, html: page.text, robotsTxt, hasSitemap });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/check") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
      try {
        const result = await check(body.url);
        // Log checked hosts (no personal data) so we can see which apps are being checked.
        if (env.CHECKS) {
          const key = `${new Date().toISOString()}|${result.host}`;
          ctx.waitUntil(env.CHECKS.put(key, JSON.stringify({ url: result.finalUrl, score: result.score, builder: result.builder, words: result.words }), { expirationTtl: 60 * 60 * 24 * 180 }));
        }
        return json(result);
      } catch (e) {
        const msg = e?.name === "TimeoutError" ? "The site took too long to answer (10 s)." : (e?.message || "Couldn't check that site.");
        return json({ error: msg }, 422);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
