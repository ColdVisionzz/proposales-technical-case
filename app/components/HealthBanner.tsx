import type { Health } from "@/lib/pipeline/health";

type Notice = { key: string; tone: "bad" | "warn"; title: string; text: string };

// Loud strips at the very top. The health flag is a hint (a ping can pass while a create fails), the chaos switch is read
// directly, and `offline` is the dashboard's own feed failing: all three can be true at once, so they stack.
export function HealthBanner({ health, chaos, offline }: { health: Health | null; chaos: boolean; offline: boolean }) {
  const notices: Notice[] = [];
  if (health?.state === "auth") {
    notices.push({ key: "auth", tone: "bad", title: "Proposales rejected our API key", text: "No drafts can be created until the key is fixed. Enquiries are saved and will wait." });
  } else if (health?.state === "down") {
    notices.push({ key: "down", tone: "bad", title: "Proposales is unreachable", text: "Enquiries are still saved and will retry on their own once it is back." });
  }
  if (chaos) {
    notices.push({ key: "chaos", tone: "warn", title: "Failure switch is on", text: "Proposales calls fail on purpose for the demo. Switch it off and queued mail goes through." });
  }
  if (offline) {
    notices.push({ key: "offline", tone: "warn", title: "Lost connection to the server", text: "Showing the last data. Trying again every 2 seconds." });
  }
  if (!notices.length) return null;

  return (
    <div className="sticky top-0 z-30">
      {notices.map((n) => (
        <div
          key={n.key}
          role={n.tone === "bad" ? "alert" : "status"}
          className={`px-4 py-2.5 text-sm md:px-8 ${n.tone === "bad" ? "bg-[color:var(--bad)] text-white" : "bg-[color:var(--peach)] text-[color:var(--peach-ink)]"}`}
        >
          <strong className="font-semibold">{n.title}.</strong> {n.text}
        </div>
      ))}
    </div>
  );
}
