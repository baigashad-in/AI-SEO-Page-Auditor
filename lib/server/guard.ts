// Protects the API routes when the app is deployed publicly, so strangers cannot spend your
// TinyFish credits. Set AUDITOR_ACCESS_TOKEN to require a token; a small per-IP rate limit always applies.

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 120; // stage calls per IP per window (one audit is about 5 to 30 calls incl. polling)
const hits = new Map<string, number[]>();

export function guard(req: Request): Response | null {
  const token = process.env.AUDITOR_ACCESS_TOKEN;
  if (token && req.headers.get("x-auditor-token") !== token) {
    return Response.json({ error: "Access token required. Enter it in the form." }, { status: 401 });
  }
  const ip = (req.headers.get("x-forwarded-for") || "local").split(",")[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= MAX_REQUESTS) {
    return Response.json({ error: "Rate limit reached. Try again in a few minutes." }, { status: 429 });
  }
  list.push(now);
  hits.set(ip, list);
  return null;
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function errorResponse(err: unknown, status = 400): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return Response.json({ error: msg.slice(0, 500) }, { status });
}
