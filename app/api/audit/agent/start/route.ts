import { startAgentRuns } from "@/lib/stages/agentStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";
import { serverLog } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readJson<{ url?: string; query?: string; location?: string }>(req);
  try {
    const url = parseInputUrl(body?.url || "").toString();
    const query = (body?.query || "").trim();
    if (!query) throw new Error("A query is required to start the agent stage.");
    const location = typeof body?.location === "string" ? body.location.slice(0, 8) : undefined;
    // Several runs of the same check (AGENT_RUNS, default 3); the page polls each one.
    const runs = await startAgentRuns(url, query, location);
    const ids = runs.filter((r) => r.runId).map((r) => r.runId);
    serverLog(
      ids.length
        ? `Agent: started ${ids.length} run${ids.length > 1 ? "s" : ""} (${ids.join(", ")}) for ${url}, "${query}"; they usually take 1 to 3 minutes`
        : `Agent: did not start (${runs.map((r) => r.error).find(Boolean)})`,
    );
    return Response.json({ runs });
  } catch (err) {
    return errorResponse(err);
  }
}
