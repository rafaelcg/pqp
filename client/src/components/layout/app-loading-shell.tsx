import { PANE_HEADER_REDESIGN } from "@/components/ui/pane-header";
import { type CSSProperties } from "react";
import { Link } from "react-router-dom";
import {
  ChannelListSkeleton,
  MessageListSkeleton,
  ServerRailSkeleton,
  Skeleton,
} from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import {
  loadChannelSidebarWidth,
} from "@/lib/channel-sidebar-width";
import { FRAME_REDESIGN, PANE_MAIN_REDESIGN, PANE_SIDE_REDESIGN, RAIL_REDESIGN } from "@/components/ui/pane";
import { cn } from "@/lib/utils";

interface AppLoadingShellProps {
  /** Already translated by the caller — this is a label, not a key. */
  label?: string;
}

export function AppLoadingShell({ label }: AppLoadingShellProps) {
  const { t } = useTranslation();
  const text = label ?? t("app.loading");
  return (
    <div
      className={cn("relative flex h-full overflow-hidden", FRAME_REDESIGN)}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={text}
    >
      <nav className={cn("flex h-full w-[72px] shrink-0 flex-col items-center border-r border-ink-4/40 bg-rail", RAIL_REDESIGN)}>
        <ServerRailSkeleton />
      </nav>

      {/* The same stored width the real column uses, so the first paint is
          already the width it is about to become. Read here rather than in an
          effect: an effect would paint 256 and then jump. */}
      <aside
        style={
          {
            "--channel-sidebar-width": `${loadChannelSidebarWidth(
              typeof window === "undefined" ? 0 : window.innerWidth,
            )}px`,
          } as CSSProperties
        }
        className={cn("hidden h-full w-[var(--channel-sidebar-width)] shrink-0 flex-col border-r border-ink-4/60 bg-channel md:flex", PANE_SIDE_REDESIGN, "md:redesign:h-auto")}
      >
        <div className="flex h-14 items-center border-b border-ink-4/60 px-4 redesign:border-b-0">
          <Skeleton className="h-5 w-28" />
        </div>
        <ChannelListSkeleton />
        <div className="mt-auto border-t border-ink-4/60 p-3 redesign:border-t-0">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </aside>

      <main className={cn("flex min-w-0 flex-1 flex-col", PANE_MAIN_REDESIGN)}>
        <header className={cn("flex h-14 shrink-0 items-center border-b border-ink-4/60 px-4", PANE_HEADER_REDESIGN)}>
          <Skeleton className="h-5 w-36" />
        </header>
        <MessageListSkeleton />
        <div className="shrink-0 border-t border-ink-4/60 p-3 redesign:border-t-0 redesign:px-4 redesign:pb-4">
          <Skeleton className="h-10 w-full rounded-lg redesign:h-12 redesign:rounded-[var(--composer-radius,1.25rem)]" />
        </div>
      </main>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/40 backdrop-blur-[1px] redesign:bg-[color:color-mix(in_oklab,var(--color-canvas)_40%,transparent)]">
        <div className="flex flex-col items-center gap-3">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <span className="absolute inset-0 rounded-full border-2 border-signal/20 redesign:border-[color:color-mix(in_oklab,var(--color-accent)_25%,transparent)]" />
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-signal motion-reduce:animate-none" />
            <span className="font-display text-sm font-bold text-signal redesign:font-[family-name:var(--type-title-font)] redesign:text-accent-text">
              pqp
            </span>
          </div>
          <p className="text-xs uppercase tracking-[0.2em] text-paper-muted redesign:text-[13px] redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-text-secondary">
            {text}
          </p>
        </div>
      </div>
    </div>
  );
}

interface AppBootstrapErrorProps {
  message: string;
  onRetry: () => void;
}

export function AppBootstrapError({ message, onRetry }: AppBootstrapErrorProps) {
  const { t } = useTranslation();
  return (
    <div className="relative flex h-full flex-col items-start justify-end overflow-hidden p-8 sm:p-12">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_80%_10%,var(--glow-danger),transparent_45%)]" />
      <div className="relative z-10 max-w-lg">
        <Link
          to="/"
          className="mb-3 inline-block text-xs uppercase tracking-[0.28em] text-signal redesign:text-[13px] redesign:font-semibold redesign:normal-case redesign:tracking-normal redesign:text-accent-text"
        >
          pqp.gg
        </Link>
        <h1 className="font-display text-4xl font-extrabold leading-[0.95] sm:text-5xl redesign:font-[family-name:var(--type-title-font)] redesign:font-bold redesign:text-balance">
          {t("bootstrapError.title")}
        </h1>
        <p className="mt-4 text-paper-muted redesign:text-text-secondary">{message}</p>
        <p className="mt-3 text-sm text-paper-muted">
          {t("bootstrapError.deploy.1")}{" "}
          <code className="text-signal">VITE_API_URL</code>{" "}
          {t("bootstrapError.deploy.2")}{" "}
          <code className="text-signal">VITE_WS_URL</code>{" "}
          {t("bootstrapError.deploy.3")}{" "}
          <code className="text-signal">docs/DEPLOY.md</code>.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button onClick={onRetry}>{t("bootstrapError.retry")}</Button>
          <Button variant="secondary" asChild>
            <Link to="/">{t("bootstrapError.home")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
