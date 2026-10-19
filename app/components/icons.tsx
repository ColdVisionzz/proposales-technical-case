// Small inline SVGs. They draw with currentColor or the page's CSS variables, so light and dark mode need no second set.

export function Envelope({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 92 68" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="env-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--mail-light)" />
          <stop offset="1" stopColor="var(--mail)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="88" height="64" rx="12" fill="url(#env-g)" />
      <path d="M8 10 46 40 84 10" fill="none" stroke="#fff" strokeOpacity="0.85" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 58 34 32M84 58 58 32" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// The sketch's mark: a bracket around "AI" with sparkles.
export function AiMark({ className }: { className?: string }) {
  const spark = "M0-11C1.5-4 4-1.5 11 0 4 1.5 1.5 4 0 11-1.5 4-4 1.5-11 0-4-1.5-1.5-4 0-11Z";
  return (
    <svg viewBox="0 0 104 104" className={className} aria-hidden="true">
      <path d="M62 24H34Q22 24 22 36V68Q22 80 34 80H64Q76 80 76 68V50" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <text x="49" y="62" textAnchor="middle" fontSize="34" fontWeight="800" fill="currentColor" style={{ fontFamily: "var(--font-geist-sans), sans-serif", letterSpacing: "-0.04em" }}>
        AI
      </text>
      <path d={spark} transform="translate(76 22) scale(0.9)" fill="currentColor" />
      <path d={spark} transform="translate(93 11) scale(0.5)" fill="currentColor" />
      <path d={spark} transform="translate(90 36) scale(0.55)" fill="currentColor" />
    </svg>
  );
}

export function Crack({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 56" className={className} aria-hidden="true">
      <path d="M28 2 21 18 33 24 19 38 30 44 24 54" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}
