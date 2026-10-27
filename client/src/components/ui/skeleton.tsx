import { translateMessage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[var(--radius-control)] bg-surface-3/50",
        className,
        "redesign:bg-[color:var(--skeleton-bg)] redesign:motion-reduce:animate-none",
      )}
      aria-hidden
    />
  );
}

/** A channel row's placeholder: the row's pill and height under the redesign. */
const ROW = "redesign:h-[var(--control-row)] redesign:rounded-[var(--radius-row)]";

export function ChannelListSkeleton() {
  return (
    <div className="space-y-4 p-2" aria-busy="true" aria-label={translateMessage("a11y.loadingChannels")}>
      <div className="space-y-2 px-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className={cn("h-8 w-full", ROW)} />
        <Skeleton className={cn("h-8 w-[85%]", ROW)} />
        <Skeleton className={cn("h-8 w-[70%]", ROW)} />
      </div>
      <div className="space-y-2 px-2">
        <Skeleton className="h-3 w-14" />
        <Skeleton className={cn("h-8 w-full", ROW)} />
        <Skeleton className={cn("h-8 w-[75%]", ROW)} />
      </div>
    </div>
  );
}

export function MessageListSkeleton() {
  return (
    <div
      className="flex flex-1 flex-col gap-5 overflow-hidden py-4"
      aria-busy="true"
      aria-label={translateMessage("a11y.loadingMessages")}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start px-5">
          <div className="flex w-14 shrink-0 justify-end pr-2">
            <Skeleton className="h-9 w-9 shrink-0 rounded-[var(--radius-card)] redesign:rounded-full" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className={`h-3.5 ${i % 2 === 0 ? "w-[90%]" : "w-[65%]"}`} />
            {i % 3 === 0 && <Skeleton className="h-3.5 w-[40%]" />}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ServerRailSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2 py-3" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-12 rounded-[var(--radius-panel)]" />
      ))}
    </div>
  );
}
