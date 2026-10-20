// A small inline set, one family: 16px grid, 1.5 stroke, round caps. They draw with currentColor, so both themes need no second set.

const base = { viewBox: "0 0 16 16", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

// The brand mark: three stages joined by a line, the last one filled.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
      <path d="M5 12h14" />
      <circle cx="5" cy="12" r="2.25" fill="var(--background)" />
      <circle cx="12" cy="12" r="2.25" fill="var(--background)" />
      <circle cx="19" cy="12" r="2.75" fill="var(--accent)" stroke="var(--accent)" />
    </svg>
  );
}

export function Check({ className }: { className?: string }) {
  return (
    <svg {...base} strokeWidth={2.25} className={className}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function Alert({ className }: { className?: string }) {
  return (
    <svg {...base} strokeWidth={2.25} className={className}>
      <path d="M8 3.5v5M8 12v.01" />
    </svg>
  );
}

export function Copy({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
      <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" />
    </svg>
  );
}

export function Close({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

export function ArrowUpRight({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M5 11 11 5M6 5h5v5" />
    </svg>
  );
}

// Stage glyphs for the rail: mail in, reading, drafting a document.
export function Mail({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" />
      <path d="m2.5 4.5 5.5 4 5.5-4" />
    </svg>
  );
}

export function Sparkle({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M8 2.25c.5 3.1 1.9 4.5 5 5-3.1.5-4.5 1.9-5 5-.5-3.1-1.9-4.5-5-5 3.1-.5 4.5-1.9 5-5Z" />
    </svg>
  );
}

export function Doc({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M4 1.75h5l3 3v8.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
      <path d="M9 1.75v3h3M5.5 8.25h5M5.5 10.75h3" />
    </svg>
  );
}

export function Refresh({ className }: { className?: string }) {
  return (
    <svg {...base} className={className}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
      <path d="M13.25 2.5v2.75h-2.75" />
    </svg>
  );
}

// GitHub's Octicon mark (filled, so it skips the stroke defaults the rest of the set uses).
export function GitHub({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
