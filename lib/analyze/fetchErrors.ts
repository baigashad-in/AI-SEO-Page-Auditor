// Plain-English meaning of TinyFish Fetch per-URL error codes (from the Fetch API reference).

const FETCH_ERROR_HELP: Record<string, string> = {
  bot_blocked: "The site served a bot-protection challenge instead of the page.",
  login_required: "The page redirects anonymous visitors to a login wall.",
  empty_content: "The page loaded but had no extractable text.",
  timeout: "The page did not finish loading in time.",
  page_not_found: "The page returned 404 or 410.",
  target_http_error: "The server returned an error status.",
  target_unreachable: "DNS, TLS or connection failure.",
  content_too_large: "The document is larger than Fetch's size limit.",
  invalid_url: "The URL was rejected (private address or invalid scheme).",
};

export function fetchErrorHelp(code: string): string {
  return FETCH_ERROR_HELP[code] || code;
}
