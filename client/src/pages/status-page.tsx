import { useCallback, useEffect, useState } from "react";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { Seo } from "@/components/marketing/seo";
import { getApiBaseUrl } from "@/lib/utils";
import { cn } from "@/lib/utils";

type ComponentState = "operational" | "degraded" | "down" | "disabled";

interface ComponentStatus {
  key: string;
  label: string;
  state: ComponentState;
  latencyMs?: number;
  uptime24h: number | null;
  uptime7d: number | null;
}

interface StatusSummary {
  state: ComponentState;
  components: ComponentStatus[];
  checkedAt: string;
}

/** How often the page re-checks. Matches the server's own sampling cadence. */
const POLL_MS = 60_000;

const STATE_COPY: Record<ComponentState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  down: "Down",
  disabled: "Not enabled",
};

const HEADLINE: Record<ComponentState, string> = {
  operational: "All systems operational",
  degraded: "Partial degradation",
  down: "Major outage",
  disabled: "All systems operational",
};

/**
 * Colour is doubled by the dot's shape and by the written state, never carried
 * alone — a status page that only encodes severity as red/green is unreadable
 * to a chunk of the people who need it most.
 */
const STATE_STYLES: Record<ComponentState, { dot: string; text: string }> = {
  operational: { dot: "bg-success", text: "text-success" },
  degraded: { dot: "bg-warning", text: "text-warning" },
  down: { dot: "bg-danger", text: "text-danger" },
  disabled: { dot: "bg-ink-4", text: "text-paper-muted" },
};

function formatUptime(value: number | null): string {
  if (value === null) {
    return "—";
  }
  const percent = value * 100;
  // Never round 99.4% up to a clean "100%": on a status page that reads as a
  // claim of no downtime, which is the one number people check afterwards.
  const rounded = percent >= 99.995 ? 100 : Math.floor(percent * 100) / 100;
  return `${rounded}%`;
}

export function StatusPage() {
  const [status, setStatus] = useState<StatusSummary | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/status.json`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(String(res.status));
      }
      setStatus((await res.json()) as StatusSummary);
      setError(false);
    } catch {
      // The API being unreachable *is* status information, so this renders as
      // an outage rather than as a broken page.
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const headlineState: ComponentState = error ? "down" : (status?.state ?? "operational");
  const headline = error ? "Cannot reach the API" : HEADLINE[headlineState];
  const styles = STATE_STYLES[headlineState];

  return (
    <div className="flex min-h-full flex-col bg-ink text-paper">
      <Seo
        title="Status — pqp"
        description="Live operational status for the hosted pqp service."
        path="/status"
      />
      <MarketingNav variant="solid" />
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-8 sm:py-16">
        <p className="text-xs uppercase tracking-[0.2em] text-signal">Status</p>

        <div className="mt-3 flex items-center gap-3">
          <span
            className={cn(
              "h-3 w-3 shrink-0 rounded-full",
              styles.dot,
              headlineState !== "operational" && "animate-pulse",
            )}
            aria-hidden="true"
          />
          <h1 className="font-display text-3xl font-extrabold tracking-tight sm:text-4xl">
            {headline}
          </h1>
        </div>

        <p aria-live="polite" className="mt-3 text-sm text-paper-muted">
          {loading
            ? "Checking…"
            : status
              ? `Checked ${new Date(status.checkedAt).toLocaleTimeString()} · refreshes every minute`
              : "Retrying every minute"}
        </p>

        {!error && status && (
          <ul className="mt-10 divide-y divide-ink-4 rounded-lg border border-ink-4">
            {status.components.map((component) => {
              const componentStyles = STATE_STYLES[component.state];
              return (
                <li
                  key={component.key}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      componentStyles.dot,
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 font-medium">
                    {component.label}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-paper-muted">
                    {formatUptime(component.uptime24h)} 24h ·{" "}
                    {formatUptime(component.uptime7d)} 7d
                  </span>
                  <span
                    className={cn(
                      "w-28 shrink-0 text-right text-sm",
                      componentStyles.text,
                    )}
                  >
                    {STATE_COPY[component.state]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p
            role="alert"
            className="mt-10 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger"
          >
            This page could not reach the API. If you are reading this, the
            static site is up and the backend is not — or your own connection is
            down.
          </p>
        )}

        <p className="mt-8 text-xs text-paper-muted">
          Uptime is measured from the service&apos;s own probes, once a minute,
          kept for 30 days. Self-hosted instances report their own numbers, not
          these.
        </p>
      </main>
      <MarketingFooter />
    </div>
  );
}
