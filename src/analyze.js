// Pure analysis of a page's raw HTML (what a crawler that doesn't run
// JavaScript receives). No network here, so it's easy to test.

const AI_BOTS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-Web", "PerplexityBot", "Google-Extended", "CCBot"];

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ");

export function visibleText(html) {
  let body = html.replace(/<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  body = body.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  return decode(body).replace(/\s+/g, " ").trim();
}

function meta(html, key) {
  // matches name= or property= in either attribute order
  const re1 = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, "i");
  const m = html.match(re1) || html.match(re2);
  return m ? decode(m[1]).trim() : null;
}

export function detectBuilder(html) {
  const h = html.toLowerCase();
  if (h.includes("lovable.dev") || h.includes("gpteng.co") || h.includes("gpt-engineer-file-uploads") || h.includes("lovable-tagger") || h.includes(".lovable.app")) return "Lovable";
  if (h.includes("bolt.new") || h.includes("stackblitz")) return "Bolt";
  if (h.includes("v0.dev") || h.includes("v0.app")) return "v0";
  if (h.includes("replit")) return "Replit";
  if (h.includes("base44")) return "Base44";
  return null;
}

export function robotsBlocks(robotsTxt) {
  // Return the AI bots that robots.txt disallows from "/".
  if (!robotsTxt) return [];
  const groups = [];
  let cur = null;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k.trim().toLowerCase(), val = rest.join(":").trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
    } else if (cur && (key === "disallow" || key === "allow")) {
      cur.rules.push({ key, val });
    }
  }
  const blocked = (agent) => {
    const g = groups.find((g) => g.agents.includes(agent.toLowerCase())) || groups.find((g) => g.agents.includes("*"));
    if (!g) return false;
    const rootDis = g.rules.some((r) => r.key === "disallow" && r.val === "/");
    const rootAllow = g.rules.some((r) => r.key === "allow" && r.val === "/");
    return rootDis && !rootAllow;
  };
  return AI_BOTS.filter(blocked);
}

export function analyze({ url, finalUrl, status, html, robotsTxt, hasSitemap }) {
  const text = visibleText(html);
  const words = text ? text.split(" ").length : 0;
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const t = title ? decode(title).trim() : null;
  const desc = meta(html, "description");
  const ogTitle = meta(html, "og:title");
  const ogDesc = meta(html, "og:description");
  const ogImage = meta(html, "og:image");
  const twCard = meta(html, "twitter:card");
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || null;
  const spaShell = /<div id=["'](root|app)["'][^>]*>\s*<\/div>/i.test(html);
  const builder = detectBuilder(html);
  const blockedBots = robotsBlocks(robotsTxt);
  const host = new URL(finalUrl || url).hostname;

  const checks = [];
  const add = (id, level, title, detail) => checks.push({ id, level, title, detail });

  // 1. Content in raw HTML — the big one.
  if (words < 30) {
    add("content", "fail", "AI crawlers see an empty page",
      `Your raw HTML has ${words} word${words === 1 ? "" : "s"} of visible text. The content only appears after JavaScript runs. Google renders JavaScript eventually, but ChatGPT, Perplexity, Claude and most link-preview bots mostly don't, so to them this page is blank.`);
  } else if (words < 150) {
    add("content", "warn", "Very little text before JavaScript runs",
      `Only ${words} words are in the raw HTML. Crawlers that don't run JavaScript get a thin version of this page.`);
  } else {
    add("content", "pass", "Content is in the HTML", `${words} words are readable without JavaScript.`);
  }

  // 2. Title
  if (!t) add("title", "fail", "No page title", "Search results and browser tabs have nothing to show.");
  else if (t.length < 15) add("title", "warn", `Title is very short: “${t}”`, "It doesn't say what the product does, which is what people search for.");
  else add("title", "pass", "Page title is set", `“${t}”`);

  // 3. Meta description
  if (!desc) add("description", "fail", "No meta description", "Search results and AI answers have no summary of what you do.");
  else add("description", "pass", "Meta description is set", `“${desc.slice(0, 160)}${desc.length > 160 ? "…" : ""}”`);

  // 4. Share image
  if (!ogImage) add("ogimage", "fail", "No share image (og:image)", "When someone shares your link on LinkedIn, X, Slack or WhatsApp, the preview has no picture.");
  else if (/lovable\.dev\/opengraph-image/i.test(ogImage)) add("ogimage", "fail", "Share image is Lovable's default", "Shared links show Lovable's image instead of yours.");
  else if (!/^https?:\/\//i.test(ogImage)) add("ogimage", "warn", "Share image uses a relative path", `og:image is “${ogImage}”. LinkedIn and Facebook often ignore relative paths, so previews can show no picture.`);
  else if (/\.lovable\.app\//i.test(ogImage) && !host.endsWith("lovable.app")) add("ogimage", "warn", "Share image is hosted on a lovable.app address", "If that Lovable project is unpublished or renamed, every shared link loses its preview image.");
  else add("ogimage", "pass", "Share image is set", ogImage);

  // 5. Share title / description
  if (!ogTitle) add("ogtitle", "warn", "No og:title", "Link previews fall back to the page title, or show nothing.");
  else add("ogtitle", "pass", "og:title is set", `“${ogTitle}”`);
  if (!twCard) add("twcard", "warn", "No twitter:card", "Links shared on X may show as a small plain card instead of a large image.");
  else add("twcard", "pass", "twitter:card is set", twCard);

  // 6. Robots
  if (blockedBots.length) add("robots", "warn", "robots.txt blocks some AI crawlers", `Blocked: ${blockedBots.join(", ")}. That may be on purpose, but those assistants can't read or cite your site.`);
  else add("robots", "pass", "AI crawlers are allowed in robots.txt", robotsTxt ? "No AI bot is blocked from your homepage." : "No robots.txt found, which means everything is allowed.");

  // 7. Sitemap
  if (!hasSitemap) add("sitemap", "warn", "No sitemap.xml found", "Crawlers have to discover your pages by following links. A sitemap tells them every page you want indexed.");
  else add("sitemap", "pass", "sitemap.xml found", "");

  // 8. Canonical
  if (!canonical) add("canonical", "warn", "No canonical URL", "If your site answers on several addresses (www, lovable.app), search engines may split your ranking between them.");
  else add("canonical", "pass", "Canonical URL is set", canonical);

  const weight = { fail: 0, warn: 0.5, pass: 1 };
  const importance = { content: 4, title: 1.5, description: 1.5, ogimage: 1.5, ogtitle: 0.5, twcard: 0.5, robots: 1, sitemap: 1, canonical: 0.5 };
  let got = 0, max = 0;
  for (const c of checks) { const w = importance[c.id] || 1; max += w; got += w * weight[c.level]; }
  let score = Math.round((got / max) * 100);
  // An empty page is the main problem; perfect meta tags can't make up for it.
  if (words < 30) score = Math.min(score, 35);

  return {
    url, finalUrl, status, host, builder, spaShell, words,
    textSample: text.slice(0, 280),
    preview: { title: ogTitle || t, description: ogDesc || desc, image: ogImage && /^https?:\/\//i.test(ogImage) ? ogImage : null, host },
    checks, score,
  };
}
