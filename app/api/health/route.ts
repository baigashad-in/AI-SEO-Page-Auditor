export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tells the UI whether the server is configured. Never returns the key itself.
export async function GET() {
  return Response.json({
    keyConfigured: Boolean(process.env.TINYFISH_API_KEY),
    tokenRequired: Boolean(process.env.AUDITOR_ACCESS_TOKEN),
  });
}
