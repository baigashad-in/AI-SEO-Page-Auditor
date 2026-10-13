// Browser-side orchestration. Each TinyFish stage runs in its own short API request so the app
// works on serverless hosts with request time limits. The report is built here from the results.

import type { AgentStageResult, AuditInput, AuditReport, BrowserStageResult, FetchStageResult, SearchStageResult } from "../types";
import { buildReport } from "../analyze/report";
import { pageSignals, resolveQuery } from "../analyze/query";
import { mergeAgentRuns } from "../analyze/agentRuns";

export type StageName = "fetch" | "browser" | "search" | "agent";
export type StageState = { status: "waiting" | "running" | "done" | "failed" | "skipped"; note?: string };
export type Progress = Record<StageName, StageState> & { query?: string };

export interface ClientOptions {
  useBrowser: boolean;
  useAgent: boolean;
  token?: string;
  onProgress: (p: Progress) => void;
  signal?: AbortSignal;
}

const AGENT_TIMEOUT_MS = 240_000;
const POLL_MS = 5_000;

export async function runAuditInBrowser(input: AuditInput, opts: ClientOptions): Promise<AuditReport> {
  const progress: Progress = {
    fetch: { status: "running" },
    browser: { status: opts.useBrowser ? "running" : "skipped" },
    search: { status: "waiting" },
    agent: { status: opts.useAgent ? "waiting" : "skipped" },
  };
  const emit = () => opts.onProgress({ ...progress });
  emit();

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token) headers["x-auditor-token"] = opts.token;

  async function post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j as T;
  }
  async function get<T>(path: string): Promise<T> {
    const r = await fetch(path, { headers, signal: opts.signal });
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j as T;
  }

  // Fetch and Browser run in parallel: both only need the URL.
  const fetchP = post<FetchStageResult>("/api/audit/fetch", input).then(
    (r) => {
      progress.fetch = r.page ? { status: "done", note: `${r.stats?.words ?? 0} words extracted` } : { status: "failed", note: r.pageError?.error };
      emit();
      return r;
    },
    (e: Error) => {
      progress.fetch = { status: "failed", note: e.message };
      emit();
      return null;
    },
  );
  const browserP: Promise<BrowserStageResult | null> = opts.useBrowser
    ? post<BrowserStageResult>("/api/audit/browser", { url: input.url }).then(
        (r) => {
          progress.browser = !r.ok
            ? { status: "failed", note: r.error }
            : r.challenge
              ? { status: "done", note: "got a bot challenge page, not the content" }
              : r.rawChallenge
                ? { status: "done", note: `first HTML response was a bot challenge; rendered ${r.rendered?.words} words` }
                : { status: "done", note: `raw ${r.raw?.words} / rendered ${r.rendered?.words} words` };
          emit();
          return r;
        },
        (e: Error) => {
          progress.browser = { status: "failed", note: e.message };
          emit();
          return null;
        },
      )
    : Promise.resolve(null);

  const [fetchRes, browserRes] = await Promise.all([fetchP, browserP]);
  const { query, derived } = resolveQuery(input, fetchRes, browserRes);
  progress.query = query;
  progress.search = { status: "running" };
  if (opts.useAgent) progress.agent = { status: "running", note: "starting" };
  emit();

  const searchP = post<SearchStageResult>("/api/audit/search", {
    url: input.url,
    query,
    queryDerived: derived,
    location: input.location,
    ...pageSignals(fetchRes, browserRes),
  }).then(
    (r) => {
      progress.search = { status: "done", note: r.target.position ? `#${r.target.position} for "${r.query}"` : `not in top ${r.pagesChecked * 10}` };
      emit();
      return r;
    },
    (e: Error) => {
      progress.search = { status: "failed", note: e.message };
      emit();
      return null;
    },
  );

  type Started = { runId: string | null; error?: string; calls: AgentStageResult["calls"] };
  const agentP: Promise<AgentStageResult | null> = opts.useAgent
    ? (async () => {
        try {
          // The server starts the same check several times (AGENT_RUNS, default 3); each run is polled here.
          const { runs } = await post<{ runs: Started[] }>("/api/audit/agent/start", { url: input.url, query, location: input.location });
          if (!runs.some((r) => r.runId)) throw new Error(runs.map((r) => r.error).find(Boolean) || "Agent run did not start");
          const n = runs.length;
          const deadline = Date.now() + AGENT_TIMEOUT_MS;
          const started = Date.now();
          let finished = 0;
          const note = (status: string) => {
            progress.agent = { status: "running", note: `${n > 1 ? `${finished} of ${n} runs finished, ` : `${status.toLowerCase()}, `}${Math.round((Date.now() - started) / 1000)}s` };
            emit();
          };
          const one = async (s: Started): Promise<AgentStageResult> => {
            if (!s.runId) return { ok: false, runId: null, status: "NOT_STARTED", error: s.error, query, answer: null, calls: s.calls };
            const id = encodeURIComponent(s.runId);
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, POLL_MS));
              const res = await get<AgentStageResult>(`/api/audit/agent/status?runId=${id}&query=${encodeURIComponent(query)}`);
              if (["COMPLETED", "FAILED", "CANCELLED"].includes(res.status)) {
                finished++;
                note(res.status);
                return { ...res, calls: [...s.calls, ...res.calls] };
              }
              note(res.status);
            }
            await get(`/api/audit/agent/status?runId=${id}&cancel=1`).catch(() => {});
            finished++;
            const error = `Agent did not finish in ${AGENT_TIMEOUT_MS / 1000}s and was cancelled`;
            return { ok: false, runId: s.runId, status: "TIMEOUT", error, query, answer: null, calls: [...s.calls, { endpoint: "agent", purpose: "Answerability run", ms: AGENT_TIMEOUT_MS, ok: false, detail: "timed out, cancelled" }] };
          };
          const res = mergeAgentRuns(await Promise.all(runs.map(one)));
          const found = (res.runs ?? [res]).filter((x) => x.ok && x.answer?.answer_found).length;
          progress.agent = res.ok
            ? { status: "done", note: n > 1 ? `answer found in ${found} of ${n} runs` : res.answer?.answer_found ? "answer found" : "no answer on page" }
            : { status: "failed", note: res.error || res.status };
          emit();
          return res;
        } catch (e) {
          progress.agent = { status: "failed", note: (e as Error).message };
          emit();
          return { ok: false, runId: null, status: "FAILED", error: (e as Error).message, query, answer: null, calls: [] };
        }
      })()
    : Promise.resolve(null);

  const [searchRes, agentRes] = await Promise.all([searchP, agentP]);
  return buildReport(
    { fetch: fetchRes, browser: browserRes, search: searchRes, agent: agentRes, query, queryDerived: derived, url: input.url },
    input,
  );
}
