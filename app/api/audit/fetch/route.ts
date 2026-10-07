import { runFetchStage } from "@/lib/stages/fetchStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readJson<{ url?: string; query?: string; location?: string }>(req);
  try {
    const url = parseInputUrl(body?.url || "").toString();
    return Response.json(await runFetchStage({ url, query: body?.query, location: body?.location }));
  } catch (err) {
    return errorResponse(err);
  }
}
