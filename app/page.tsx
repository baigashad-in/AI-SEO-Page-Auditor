"use client";

import { useEffect, useRef, useState } from "react";
import Report from "@/components/Report";
import type { AuditReport } from "@/lib/types";
import { runAuditInBrowser, type Progress, type StageName } from "@/lib/client/runAudit";
import { parseInputUrl } from "@/lib/url";

const STAGES: { key: StageName; name: string; what: string }[] = [
  { key: "fetch", name: "Fetch", what: "What an AI fetch tool extracts, plus robots.txt, llms.txt and sitemap" },
  { key: "browser", name: "Browser", what: "Raw server HTML vs the rendered page, and requests as AI crawlers" },
  { key: "search", name: "Search", what: "Where the page ranks, whether it is indexed, who ranks above it" },
  { key: "agent", name: "Agent", what: "Whether an AI agent can answer the query on the live page" },
];

const STATE_WORD = { waiting: "Waiting", running: "Running", done: "Done", failed: "Failed", skipped: "Skipped" };

const COUNTRIES = ["US", "GB", "CA", "AU", "IN", "DE", "FR", "ES", "JP", "BR"];

export default function Home() {
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("US");
  const [useBrowser, setUseBrowser] = useState(true);
  const [useAgent, setUseAgent] = useState(true);
  const [token, setToken] = useState("");
  const [health, setHealth] = useState<{ keyConfigured: boolean; tokenRequired: boolean } | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let normalized: string;
    try {
      normalized = parseInputUrl(url).toString();
    } catch (err) {
      setError((err as Error).message === "Invalid URL" ? "That does not look like a web address. Try https://example.com/page" : (err as Error).message);
      return;
    }
    setReport(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const r = await runAuditInBrowser(
        { url: normalized, query: query.trim() || undefined, location },
        { useBrowser, useAgent, token: token || undefined, onProgress: setProgress, signal: ctrl.signal },
      );
      setReport(r);
      setTimeout(() => document.getElementById("report-start")?.scrollIntoView({ behavior: "smooth" }), 50);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>What AI sees on your page</h1>
        <p>
          Paste a page. See what search engines and AI tools can actually read on it, where it shows up for the query you care about, and what to fix
          first.
        </p>
      </header>

      {health && !health.keyConfigured && (
        <p className="notice" style={{ marginTop: 24 }}>
          The server has no TinyFish API key. Add TINYFISH_API_KEY to .env.local and restart.
        </p>
      )}

      <form className="audit-form" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="url">Page URL</label>
          <input id="url" type="text" inputMode="url" placeholder="https://example.com/pricing" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="query">
              Search query you want this page to show up for <span className="hint">(optional)</span>
            </label>
            <input id="query" type="text" placeholder="e.g. best crm for small agencies" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="loc">Search country</label>
            <select id="loc" value={location} onChange={(e) => setLocation(e.target.value)}>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        {health?.tokenRequired && (
          <div className="field">
            <label htmlFor="token">Access token</label>
            <input id="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </div>
        )}
        <div className="checks">
          <label>
            <input type="checkbox" checked={useBrowser} onChange={(e) => setUseBrowser(e.target.checked)} />
            Compare raw HTML with the rendered page (TinyFish Browser, uses credits)
          </label>
          <label>
            <input type="checkbox" checked={useAgent} onChange={(e) => setUseAgent(e.target.checked)} />
            Ask an AI agent to answer the query on the live page (TinyFish Agent, uses credits, about 1 to 3 minutes)
          </label>
        </div>
        <div className="actions">
          <button className="btn" type="submit" disabled={running}>
            {running ? "Auditing" : "Run audit"}
          </button>
          {running && (
            <button type="button" className="btn-quiet" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          )}
        </div>
      </form>

      {error && (
        <p className="error-line" role="alert" style={{ marginTop: 20 }}>
          {error}
        </p>
      )}

      {progress && (
        <ul className="stages" aria-live="polite">
          {STAGES.map((s) => {
            const st = progress[s.key];
            return (
              <li key={s.key}>
                <span className="name">{s.name}</span>
                <span className="what">{s.what}</span>
                <span className={`state state-${st.status}`}>
                  {STATE_WORD[st.status]}
                  {st.note ? `: ${st.note}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div id="report-start" />
      {report && <Report report={report} />}

      <p className="footer-note">
        Uses TinyFish Search and Fetch (free tiers) and Browser and Agent (credits). Audits the live page on every run. Rankings come from TinyFish
        Search&rsquo;s own index, so treat positions as directional.
      </p>
    </main>
  );
}
