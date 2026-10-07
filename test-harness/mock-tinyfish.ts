// Mock of the four TinyFish APIs, following the documented request and response shapes.
// For local testing only: real audits must use the real TinyFish endpoints.
// Fetch and Browser are backed by a real local Chromium (CDP on port 9222), so rendering is genuine.
//
// Run: npx tsx test-harness/mock-tinyfish.ts   (needs Chrome started with --remote-debugging-port=9222)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { chromium, type Browser } from "playwright-core";
import { startSite } from "./site";

const CDP_HTTP = "http://127.0.0.1:9222";
const SITE_PORT = 4100;
const API_PORT = 4200;
let browser: Browser | null = null;

async function getBrowser() {
  if (!browser) browser = await chromium.connectOverCDP(CDP_HTTP);
  return browser;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** Plain HTTP GET to the local site with the right Host header (for robots.txt, sitemap, llms.txt). */
function rawGet(url: string): Promise<{ status: number; type: string; text: string }> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const r = httpRequest({ host: "127.0.0.1", port: SITE_PORT, path: u.pathname + u.search, headers: { host: u.host } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, type: String(res.headers["content-type"] || ""), text: t }));
    });
    r.on("error", () => resolve({ status: 0, type: "", text: "" }));
    r.end();
  });
}

async function renderToMarkdown(url: string) {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });
  // Passed as a string so the TS runner does not inject helpers into browser code.
  const data: any = await page.evaluate(String.raw`(() => {
    const root = document.querySelector("main, article") || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll("nav, header, footer, aside, script, style, button, #cookie").forEach((n) => n.remove());
    const lines = [];
    const walk = (el) => {
      for (const child of Array.from(el.children)) {
        const tag = child.tagName.toLowerCase();
        const text = (child.textContent || "").replace(/\s+/g, " ").trim();
        if (/^h[1-6]$/.test(tag)) lines.push("#".repeat(Number(tag[1])) + " " + text, "");
        else if (tag === "p") lines.push(text, "");
        else if (tag === "li") lines.push("- " + text);
        else if (tag === "tr") lines.push("| " + Array.from(child.children).map((c) => (c.textContent || "").trim()).join(" | ") + " |");
        else walk(child);
      }
    };
    walk(clone);
    const meta = (sel) => (document.querySelector(sel) || {}).content || null;
    return {
      title: meta('meta[property="og:title"]') || document.title || null,
      description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
      language: document.documentElement.lang || null,
      text: lines.join("\n"),
      links: Array.from(document.querySelectorAll("a[href]")).map((a) => a.href),
      images: Array.from(document.querySelectorAll("img[src]")).map((i) => i.src),
      final: location.href,
    };
})()`);
  await ctx.close();
  return data;
}

const SERP = (q: string) => ({
  query: q,
  total_results: 8,
  page: 0,
  results: [
    { position: 1, site_name: "comp-one.example", title: "Planwise pricing: plans per user", snippet: "Planwise pricing is per user per month.", url: "http://comp-one.example/pricing" },
    { position: 2, site_name: "comp-two.example", title: "Taskly pricing: plans per user", snippet: "Annual billing gives a discount.", url: "http://comp-two.example/plans" },
    { position: 3, site_name: "shop.audit-demo.example", title: "About Acme Plans", snippet: "Acme builds simple project tools.", url: "http://shop.audit-demo.example/about" },
    { position: 4, site_name: "comp-three.example", title: "Boardly pricing guide", snippet: "Full pricing guide.", url: "http://comp-three.example/pricing-guide" },
    { position: 5, site_name: "www.youtube.com", title: "Pricing explained (video)", snippet: "Video.", url: "https://www.youtube.com/watch?v=abc" },
    { position: 6, site_name: "blog.other.example", title: "Comparing task tools", snippet: "Comparison.", url: "http://blog.other.example/compare" },
  ],
});

const runs = new Map<string, number>();

async function handle(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url || "/", `http://127.0.0.1:${API_PORT}`);
  if (!req.headers["x-api-key"]) return json(res, 401, { error: { code: "MISSING_API_KEY", message: "missing" } });

  // Search
  if (u.pathname === "/search" && req.method === "GET") {
    const q = u.searchParams.get("query") || "";
    if (u.searchParams.get("include_domains")) {
      return json(res, 200, { query: q, total_results: 1, page: 0, results: [SERP(q).results[2]] });
    }
    if (Number(u.searchParams.get("page") || 0) > 0) return json(res, 200, { query: q, total_results: 0, page: 1, results: [] });
    return json(res, 200, SERP(q));
  }

  // Fetch
  if (u.pathname === "/fetch" && req.method === "POST") {
    const b = JSON.parse(await body(req));
    const results: unknown[] = [];
    const errors: unknown[] = [];
    for (const url of b.urls as string[]) {
      const t0 = Date.now();
      const raw = await rawGet(url);
      if (raw.status === 404) {
        errors.push({ url, error: "page_not_found", status: 404 });
        continue;
      }
      if (raw.status >= 400 || raw.status === 0) {
        errors.push({ url, error: raw.status ? "target_http_error" : "target_unreachable", status: raw.status || undefined });
        continue;
      }
      if (!raw.type.includes("html")) {
        results.push({ url, final_url: url, title: null, description: null, language: null, author: null, published_date: null, text: raw.text, links: [], image_links: [], latency_ms: Date.now() - t0, format: "markdown" });
        continue;
      }
      const d = await renderToMarkdown(url);
      results.push({
        url,
        final_url: d.final,
        title: d.title,
        description: d.description,
        language: d.language,
        author: null,
        published_date: null,
        text: d.text,
        ...(b.links ? { links: d.links } : {}),
        ...(b.image_links ? { image_links: d.images } : {}),
        latency_ms: Date.now() - t0,
        format: "markdown",
      });
    }
    return json(res, 200, { results, errors });
  }

  // Browser
  if (u.pathname === "/browser" && req.method === "POST") {
    const v = await fetch(`${CDP_HTTP}/json/version`).then((r) => r.json());
    return json(res, 201, { session_id: `br-${Date.now()}`, cdp_url: v.webSocketDebuggerUrl, base_url: CDP_HTTP });
  }
  if (u.pathname.startsWith("/browser/") && req.method === "DELETE") {
    res.writeHead(204);
    return res.end();
  }

  // Agent
  if (u.pathname === "/agent/v1/automation/run-async" && req.method === "POST") {
    const b = JSON.parse(await body(req));
    if (!b.url || !b.goal || !b.output_schema) return json(res, 400, { error: { code: "INVALID_INPUT", message: "url, goal, output_schema" } });
    const id = `run_${Date.now()}`;
    runs.set(id, 0);
    return json(res, 200, { run_id: id, error: null });
  }
  const m = u.pathname.match(/^\/agent\/v1\/runs\/([\w-]+)(\/cancel)?$/);
  if (m) {
    const n = (runs.get(m[1]) ?? 0) + 1;
    runs.set(m[1], n);
    if (m[2]) return json(res, 200, { run_id: m[1], status: "CANCELLED" });
    if (n < 2) return json(res, 200, { run_id: m[1], status: "RUNNING", result: null, error: null, num_of_steps: n * 3, steps: [] });
    return json(res, 200, {
      run_id: m[1],
      status: "COMPLETED",
      num_of_steps: 9,
      error: null,
      steps: [],
      result: {
        answer_found: true,
        answer_summary: "Plans cost $8 to $25 per user per month, and you get a full refund within 30 days.",
        evidence_quote: "You get a full refund within 30 days of purchase, no questions asked.",
        answer_location: "after_interaction",
        interactions_needed: ["Dismissed cookie overlay", "Clicked the Refund policy tab"],
        blockers: [{ type: "cookie_wall", description: "Full-screen cookie overlay covered the content until accepted" }],
        page_purpose: "Pricing page for Acme project management plans.",
        missing_information: ["Whether annual billing is discounted", "Whether there is a free trial"],
      },
    });
  }
  json(res, 404, { error: { code: "NOT_FOUND", message: u.pathname } });
}

startSite(SITE_PORT);
createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: { code: "INTERNAL_ERROR", message: String(e) } }));
}).listen(API_PORT, "127.0.0.1", () => console.log(`mock TinyFish on :${API_PORT}, test site on :${SITE_PORT}`));
