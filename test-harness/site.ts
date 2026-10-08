// Local test website with known problems, used only for end-to-end testing.
// Chrome maps *.example to this server with --host-resolver-rules.

import { createServer } from "node:http";

const TARGET = "shop.audit-demo.example";

const pricingShell = `<!doctype html><html><head><meta charset="utf-8"><title>Loading</title>
<script src="/static/js/main.1a2b3c.js" defer></script></head>
<body><header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/pricing">Pricing</a></nav></header>
<div id="root"></div><footer><p>Acme Plans 2026</p></footer></body></html>`;

const appJs = `
document.title = "Pricing | Acme Plans";
var l = document.createElement("link"); l.rel = "canonical"; l.href = "http://${TARGET}/pricing"; document.head.appendChild(l);
var root = document.getElementById("root");
root.innerHTML = '<main><h1>Acme pricing for small teams</h1>' +
  '<p>Acme helps small teams plan projects, track work and share updates in one place. Pick the plan that fits how your team works today and change it whenever you need to.</p>' +
  '<h2>Plans</h2><ul><li>Basic: $8 per user per month, up to 10 projects</li><li>Pro: $15 per user per month, unlimited projects and reports</li><li>Business: $25 per user per month, SSO and audit logs</li></ul>' +
  '<h2>What every plan includes</h2><p>Every plan includes task boards, file sharing, comments, mobile apps and email support. Pro and Business add reporting dashboards and priority support for teams that grow quickly.</p>' +
  '<h2>Which plan fits your team</h2><p>Teams of two to five people usually start on Basic. Once you run more than ten projects at a time or need weekly reports for clients, Pro saves time. Business is for companies that need single sign-on, audit logs and a named contact for onboarding and security reviews.</p>' +
  '<h2>Questions</h2><div class="tabs"><button id="t-billing">Billing</button><button id="t-refund">Refund policy</button></div><div id="tab-body"><p>Billing happens every month on the day you signed up.</p></div></main>';
document.getElementById("t-refund").addEventListener("click", function () {
  document.getElementById("tab-body").innerHTML = "<p>You get a full refund within 30 days of purchase, no questions asked.</p>";
});
var cookie = document.createElement("div");
cookie.id = "cookie"; cookie.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);color:#fff;padding:40px";
cookie.innerHTML = "<p>We use cookies. <button onclick=\\"this.parentNode.parentNode.remove()\\">Accept</button></p>";
document.body.appendChild(cookie);
`;

const robots = `User-agent: *
Disallow: /admin/

User-agent: GPTBot
Disallow: /

User-agent: PerplexityBot
Disallow: /pricing

Sitemap: http://${TARGET}/sitemap.xml
`;

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>http://${TARGET}/</loc></url>
<url><loc>http://${TARGET}/about</loc></url>
</urlset>`;

const about = `<!doctype html><html lang="en"><head><title>About Acme Plans</title></head><body><main><h1>About Acme</h1>
<p>Acme builds simple project tools for small teams. We started in 2019 and serve teams in 40 countries.</p></main></body></html>`;

function competitor(name: string, extra: string) {
  return `<!doctype html><html lang="en"><head><title>${name} pricing: plans per user</title>
<meta name="description" content="${name} pricing per user with annual billing discount and a free trial.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}"}</script></head>
<body><nav><a href="/">Home</a></nav><main><article><h1>${name} pricing</h1>
<p>${name} pricing is per user per month. Annual billing gives a discount of two months. Every plan starts with a free trial of 14 days and you can cancel anytime.</p>
<h2>Plans and prices per seat</h2><table><tr><th>Plan</th><th>Price per seat</th></tr><tr><td>Starter</td><td>$7</td></tr><tr><td>Team</td><td>$14</td></tr><tr><td>Enterprise</td><td>Custom</td></tr></table>
<h2>Annual billing discount</h2><p>Pay yearly with annual billing and save on every seat. The discount applies to all plans and the free trial converts to annual billing only if you choose it.</p>
<h2>Free trial and money back guarantee</h2><p>Start a free trial with no card. After purchase there is a money back guarantee, and you can cancel anytime from settings.</p>
<h2>Refund policy</h2><p>Refund requests are handled by support within two business days under our money back guarantee.</p>
${extra}
<h2>Frequently asked questions</h2><ul><li>Is there a free trial? Yes, 14 days.</li><li>Can I cancel anytime? Yes.</li><li>Do you offer a discount for annual billing? Yes.</li><li>Do you charge per seat? Yes, per seat per month.</li><li>Is there a nonprofit discount? Yes.</li><li>Can I change plans? Anytime.</li><li>Do prices include tax? No.</li><li>Do you offer invoices? Yes.</li></ul>
</article></main><footer>Footer links</footer></body></html>`;
}

// A bot challenge served with HTTP 200, shaped like Reddit's: a large inline <style> pushes <title>
// past the first 60,000 characters, and the text uses entities.
const challengePage = `<!doctype html><html><head><style>${".c{color:#111;margin:0}".repeat(4000)}</style>
<title>Example - Prove your humanity</title></head><body><main><h1>Prove&nbsp;your humanity</h1>
<p>We&#8217;re committed to safety and security. But not for bots. Complete the challenge below.</p></main></body></html>`;

// A JavaScript app shell, shaped like Medium's blog page: few words in the server HTML, a reCAPTCHA
// script, and the Cloudflare detection script reference that ordinary pages carry. Not a challenge.
const blogShell = `<!doctype html><html><head><title>Example Blog</title>
<script src="https://www.google.com/recaptcha/api.js" async></script></head>
<body><nav>Open in app Sign up Sign in Write Search</nav><h2>The Example Blog</h2><p>3.4M followers, 5+ editors</p>
<div id="feed"></div>
<script>(function(){var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";document.head.appendChild(a);})();</script>
<script>document.getElementById("feed").innerHTML=Array.from({length:12},function(_,i){return "<article><h2>Product update "+(i+1)+"</h2><p>"+
"We shipped a new way to follow writers, better stats pages for authors, and a faster editor that keeps drafts in sync across devices. ".repeat(3)+"</p></article>";}).join("");</script>
</body></html>`;

const pages: Record<string, Record<string, { type: string; body: string }>> = {
  "verify.audit-demo.example": {
    "/r/seo/": { type: "text/html", body: challengePage },
    "/robots.txt": { type: "text/plain", body: "# Example robots.txt\nUser-agent: *\nDisallow: /\n" },
  },
  "blog.audit-demo.example": {
    "/blog": { type: "text/html", body: blogShell },
    "/robots.txt": { type: "text/plain", body: "User-agent: *\nAllow: /\n" },
  },
  [TARGET]: {
    "/pricing": { type: "text/html", body: pricingShell },
    "/static/js/main.1a2b3c.js": { type: "application/javascript", body: appJs },
    "/robots.txt": { type: "text/plain", body: robots },
    "/sitemap.xml": { type: "application/xml", body: sitemap },
    "/about": { type: "text/html", body: about },
    "/": { type: "text/html", body: about },
  },
  "comp-one.example": { "/pricing": { type: "text/html", body: competitor("Planwise", "<p>Planwise also offers volume pricing for teams above 50 seats.</p>") } },
  "comp-two.example": { "/plans": { type: "text/html", body: competitor("Taskly", "<p>Taskly includes guest users at no extra cost on annual billing.</p>") } },
  "comp-three.example": { "/pricing-guide": { type: "text/html", body: competitor("Boardly", "<p>Boardly publishes a full pricing guide with a calculator.</p>") } },
};

export function startSite(port = 4100) {
  const server = createServer((req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const path = (req.url || "/").split("?")[0];
    const ua = String(req.headers["user-agent"] || "");
    if (host === TARGET && /ClaudeBot/i.test(ua)) {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<html><head><title>Just a moment...</title></head><body><div class=cf-chl>Checking your browser</div></body></html>");
      return;
    }
    const page = pages[host]?.[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>Not found</h1>");
      return;
    }
    res.writeHead(200, { "content-type": page.type });
    res.end(page.body);
  });
  server.listen(port, "127.0.0.1");
  return server;
}
