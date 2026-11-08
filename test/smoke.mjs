// Runs the worker's check() logic in Node against live sites.
import worker from "../src/worker.js";
const urls = process.argv.slice(2).length ? process.argv.slice(2) : ["willyoumerry.me", "voicebrief.io", "nexusbenders.bd", "localhost"];
for (const u of urls) {
  const req = new Request("https://x/api/check", { method: "POST", body: JSON.stringify({ url: u }) });
  const res = await worker.fetch(req, {}, { waitUntil() {} });
  const d = await res.json();
  if (d.error) { console.log(u, "->", res.status, d.error); continue; }
  console.log(`${u} -> score ${d.score}, ${d.words} words, builder ${d.builder}`);
  for (const c of d.checks) console.log(`   [${c.level}] ${c.title}`);
}
