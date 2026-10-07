import { pollAgentStage } from "@/lib/stages/agentStage";
import { tfCancelAgentRun } from "@/lib/tinyfish";
import { errorResponse, guard } from "@/lib/server/guard";

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
      return Response.json({ cancelled: true });
    }
    return Response.json(await pollAgentStage(runId, query));
  } catch (err) {
    return errorResponse(err);
  }
}
