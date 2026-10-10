import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface SettingsSkeletonRowProps {
  /** A tile or avatar before the label, like the row it stands in for. */
  leading?: "tile" | "avatar";
  /** A second, shorter line under the label. Default `true`. */
  description?: boolean;
  /** The control on the right. Default `"button"`. */
  control?: "button" | "switch" | "none";
}

/**
 * A loading stand-in for one `SettingsRow`, at the same height, so the group
 * does not jump when the real rows land. Hidden from assistive tech; the
 * announcement belongs to `SettingsSkeletonRows`.
 */
export function SettingsSkeletonRow({
  leading,
  description = true,
  control = "button",
}: SettingsSkeletonRowProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex items-center gap-3 px-4 py-3",
        description ? "min-h-12" : "min-h-11",
      )}
    >
      {leading ? (
        <Skeleton
          className={cn(
            "h-9 w-9 shrink-0",
            leading === "avatar" && "rounded-full",
          )}
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-32 max-w-full" />
        {description ? <Skeleton className="h-3 w-48 max-w-full" /> : null}
      </div>
      {control === "button" ? (
        <Skeleton className="h-[var(--control-sm)] w-20 shrink-0" />
      ) : control === "switch" ? (
        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
      ) : null}
    </div>
  );
}

/**
 * A group's rows while they load: `count` skeleton rows divided like real
 * ones, inside one polite status that says `label` ("Carregando conexões") to
 * a screen reader. Put it in a `SettingsGroup` in place of the rows.
 */
export function SettingsSkeletonRows({
  label,
  count = 3,
  ...row
}: SettingsSkeletonRowProps & { label: string; count?: number }) {
  return (
    <div role="status" aria-busy="true" className="divide-y divide-border">
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, index) => (
        <SettingsSkeletonRow key={index} {...row} />
      ))}
    </div>
  );
}
