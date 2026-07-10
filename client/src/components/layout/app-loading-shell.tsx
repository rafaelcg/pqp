import {
  ChannelListSkeleton,
  MessageListSkeleton,
  ServerRailSkeleton,
  Skeleton,
} from "@/components/ui/skeleton";

interface AppLoadingShellProps {
  label?: string;
}

export function AppLoadingShell({
  label = "Loading…",
}: AppLoadingShellProps) {
  return (
    <div
      className="relative flex h-full overflow-hidden"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
    >
      <nav className="flex h-full w-[72px] shrink-0 flex-col items-center border-r border-ink-4/40 bg-rail">
        <ServerRailSkeleton />
      </nav>

      <aside className="hidden h-full w-64 shrink-0 flex-col border-r border-ink-4/60 bg-channel md:flex">
        <div className="flex h-14 items-center border-b border-ink-4/60 px-4">
          <Skeleton className="h-5 w-28" />
        </div>
        <ChannelListSkeleton />
        <div className="mt-auto border-t border-ink-4/60 p-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center border-b border-ink-4/60 px-4">
          <Skeleton className="h-5 w-36" />
        </header>
        <MessageListSkeleton />
        <div className="shrink-0 border-t border-ink-4/60 p-3">
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </main>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/40 backdrop-blur-[1px]">
        <div className="flex flex-col items-center gap-3">
          <div className="relative flex h-12 w-12 items-center justify-center">
            <span className="absolute inset-0 rounded-full border-2 border-signal/20" />
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-signal motion-reduce:animate-none" />
            <span className="font-display text-sm font-bold text-signal">
              pqp
            </span>
          </div>
          <p className="text-xs uppercase tracking-[0.2em] text-paper-muted">
            {label}
          </p>
        </div>
      </div>
    </div>
  );
}
