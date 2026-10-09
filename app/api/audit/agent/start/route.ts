import { startAgentStage } from "@/lib/stages/agentStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";
import { serverLog } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readJson<{ url?: string; query?: string }>(req);
  try {
    const url = parseInputUrl(body?.url || "").toString();
    const query = (body?.query || "").trim();
    if (!query) throw new Error("A query is required to start the agent stage.");
    const started = await startAgentStage(url, query);
    serverLog(started.runId ? `Agent: started run ${started.runId} (${url}, "${query}"); it usually takes 1 to 3 minutes` : `Agent: did not start (${started.error})`);
    return Response.json(started);
  } catch (err) {
    return errorResponse(err);
  }
}
