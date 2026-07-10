import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-md bg-ink-4/50",
        className,
      )}
      aria-hidden
    />
  );
}

export function ChannelListSkeleton() {
  return (
    <div className="space-y-4 p-2" aria-busy="true" aria-label="Loading channels">
      <div className="space-y-2 px-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-[85%]" />
        <Skeleton className="h-8 w-[70%]" />
      </div>
      <div className="space-y-2 px-2">
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-[75%]" />
      </div>
    </div>
  );
}

export function MessageListSkeleton() {
  return (
    <div
      className="flex flex-1 flex-col gap-5 overflow-hidden px-3 py-4 sm:px-5"
      aria-busy="true"
      aria-label="Loading messages"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-12" />
            </div>
            <Skeleton className={`h-3 ${i % 2 === 0 ? "w-[90%]" : "w-[65%]"}`} />
            {i % 3 === 0 && <Skeleton className="h-3 w-[40%]" />}
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
        <Skeleton key={i} className="h-12 w-12 rounded-2xl" />
      ))}
    </div>
  );
}
