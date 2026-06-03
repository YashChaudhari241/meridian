// Evaluate JS in the live Chrome tab over CDP (no deps; Node 22 global WebSocket/fetch).
// Usage: node debug/eval.mjs '<expression>'    e.g. node debug/eval.mjs 'document.title'
// Picks the tab whose URL contains $CDP_URL (default "youtube.com"). Set CDP_PORT to override 9222.
const PORT = process.env.CDP_PORT || 9222;
const URLF = process.env.CDP_URL || "youtube.com";
const expr = process.argv[2] || "1";

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
// CDP_TARGET=sw → drive the extension service worker (has chrome.storage etc.); else the page.
const page = process.env.CDP_TARGET === "sw"
  ? targets.find((t) => t.type === "service_worker" && /chrome-extension:\/\/[^/]+\/src\/background\.js/.test(t.url))
  : (targets.find((t) => t.type === "page" && t.url.includes(URLF)) || targets.find((t) => t.type === "page"));
if (!page) { console.error("no target found"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  const on = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) { ws.removeEventListener("message", on); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise((r) => ws.addEventListener("open", r, { once: true }));
try {
  const r = await send("Runtime.evaluate", {
    expression: `JSON.stringify((()=>{ return (${expr}); })())`,
    awaitPromise: true, returnByValue: true
  });
  const v = r.result.value;
  console.log(typeof v === "string" ? v : JSON.stringify(v));
  if (r.exceptionDetails) console.error("EXC:", JSON.stringify(r.exceptionDetails));
} catch (e) { console.error(e.message); } finally { ws.close(); }
