// URL helpers: validation and normalization so a page can be matched against search results.

const TRACKING = /^(utm_|gclid$|fbclid$|mc_cid$|mc_eid$|ref$|ref_src$|_hs)/i;

export function parseInputUrl(input: string): URL {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https URLs are supported");
  const h = u.hostname;
  if (
    h === "localhost" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h.endsWith(".local") ||
    !h.includes(".")
  ) {
    throw new Error("Private or local hosts cannot be audited. Use a public URL.");
  }
  return u;
}

export function bareHost(u: string | URL): string {
  try {
    const h = (typeof u === "string" ? new URL(u) : u).hostname.toLowerCase();
    return h.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Registrable-ish domain: last two labels, or three for common 2-level TLDs like co.uk. */
export function rootDomain(u: string | URL): string {
  const h = bareHost(u);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const twoLevel = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    const params = [...x.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const qs = params.length ? "?" + params.map(([k, v]) => `${k}=${v}`).join("&") : "";
    let path = x.pathname.replace(/\/+$/, "");
    path = path.replace(/\/(index\.html?|default\.aspx?)$/i, "");
    return `${bareHost(x)}${path || ""}${qs}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return normalizeUrl(a) === normalizeUrl(b);
}

export function sameSite(a: string, b: string): boolean {
  return rootDomain(a) !== "" && rootDomain(a) === rootDomain(b);
}

/** File-name-safe slug for a URL, e.g. "example-com-blog-post". */
export function slugForUrl(url: string): string {
  try {
    const u = new URL(/^https?:/i.test(url) ? url : `https://${url}`);
    return (u.hostname + u.pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 70) || "page";
  } catch {
    return "page";
  }
}

export function originOf(u: string): string {
  const x = new URL(u);
  return `${x.protocol}//${x.host}`;
}
