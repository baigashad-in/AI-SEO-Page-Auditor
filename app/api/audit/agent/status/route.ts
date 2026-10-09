import { pollAgentStage } from "@/lib/stages/agentStage";
import { tfCancelAgentRun } from "@/lib/tinyfish";
import { errorResponse, guard } from "@/lib/server/guard";
import { agentSummary, serverLog } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const u = new URL(req.url);
  const runId = u.searchParams.get("runId") || "";
  const query = u.searchParams.get("query") || "";
  try {
    if (!/^[\w-]{4,100}$/.test(runId)) throw new Error("Invalid runId");
    if (u.searchParams.get("cancel") === "1") {
      await tfCancelAgentRun(runId);
      serverLog(`Agent: run ${runId} cancelled (took too long)`);
      return Response.json({ cancelled: true });
    }
    const res = await pollAgentStage(runId, query);
    // The page polls every few seconds; print the status so the terminal shows the agent is working.
    serverLog(["COMPLETED", "FAILED", "CANCELLED"].includes(res.status) ? `Agent: run ${runId} finished, ${agentSummary(res)}` : `Agent: run ${runId} is ${res.status.toLowerCase()}`);
    return Response.json(res);
  } catch (err) {
    return errorResponse(err);
  }
}
