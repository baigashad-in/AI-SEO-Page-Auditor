import { runSearchStage, type SearchStageInput } from "@/lib/stages/searchStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";
import { searchSummary, serverLog, track } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readJson<SearchStageInput>(req);
  try {
    const url = parseInputUrl(body?.url || "").toString();
    return Response.json(await track("Search", () => runSearchStage({ ...(body as SearchStageInput), url }), serverLog, { subject: url, summary: searchSummary }));
  } catch (err) {
    return errorResponse(err);
  }
}
