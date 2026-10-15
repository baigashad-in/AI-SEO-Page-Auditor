// The app's mark: three lines of text that turn into dots. The solid lines are what people read on the page;
// the dots are what an AI crawler that skips JavaScript gets, the same lines with the text gone. Same drawing as
// app/icon.svg (the browser tab icon). Decorative next to the title, so hidden from screen readers.
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="15" fill="#1b2433" />
      <g strokeLinecap="round" strokeWidth="4.5">
        <g stroke="#ffffff">
          <line x1="16" y1="21" x2="31" y2="21" />
          <line x1="16" y1="32" x2="31" y2="32" />
          <line x1="16" y1="43" x2="27" y2="43" />
        </g>
        <g stroke="#9fd6ec" strokeDasharray="0.1 7.4">
          <line x1="38.5" y1="21" x2="48" y2="21" />
          <line x1="38.5" y1="32" x2="48" y2="32" />
          <line x1="38.5" y1="43" x2="41" y2="43" />
        </g>
      </g>
    </svg>
  );
}
