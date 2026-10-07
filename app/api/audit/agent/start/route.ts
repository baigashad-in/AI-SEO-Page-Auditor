import { startAgentStage } from "@/lib/stages/agentStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";

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
    return Response.json(await startAgentStage(url, query));
  } catch (err) {
    return errorResponse(err);
  }
}
