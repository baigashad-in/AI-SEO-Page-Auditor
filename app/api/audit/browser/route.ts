import { runBrowserStage } from "@/lib/stages/browserStage";
import { errorResponse, guard, readJson } from "@/lib/server/guard";
import { parseInputUrl } from "@/lib/url";
import { browserSummary, serverLog, track } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function POST(req: Request) {
  const blocked = guard(req);
  if (blocked) return blocked;
  const body = await readJson<{ url?: string }>(req);
  try {
    const url = parseInputUrl(body?.url || "").toString();
    return Response.json(await track("Browser", () => runBrowserStage({ url }), serverLog, { subject: url, summary: browserSummary }));
  } catch (err) {
    return errorResponse(err);
  }
}
