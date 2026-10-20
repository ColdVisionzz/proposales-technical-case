// Hover and keyboard-focus label for a top-bar element. Same look as the sweeper tooltip. Decorative: the child carries its own accessible name.
export function Tip({ label, align = "right", className = "", children }: { label: string; align?: "left" | "right"; className?: string; children: React.ReactNode }) {
  return (
    <div className={`group relative flex items-center ${className}`}>
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-full z-40 mt-2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-xs text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${align === "right" ? "right-0" : "left-0"}`}
      >
        {label}
      </span>
    </div>
  );
}
