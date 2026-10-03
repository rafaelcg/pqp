import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsGroupProps {
  title?: string;
  description?: string;
  /** One ghost or secondary `sm` button, or a link, on the title line. */
  action?: ReactNode;
  /**
   * `card` (default) draws the box and divides its rows. `plain` is for
   * children that are their own boxes: a choice grid, a preview.
   */
  surface?: "card" | "plain";
  children: ReactNode;
  className?: string;
}

/**
 * A titled box of rows: the unit every settings tab is built from.
 *
 * The box is elevation level 1 with the `surface-card` background written
 * after it, which is the one override DESIGN.md allows at a level. In dark that
 * is the panel colour lifted by its border; in light it is a lighter box on the
 * grey pane. Rows inside draw their own hover and an inset focus ring, because
 * the box clips (`overflow-hidden`) to keep the rounded corners on a hovered
 * first or last row.
 */
export function SettingsGroup({
  title,
  description,
  action,
  surface = "card",
  children,
  className,
}: SettingsGroupProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={title ? titleId : undefined}
      className={className}
    >
      {title || action ? (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title ? (
              <h4 id={titleId} className="text-sm font-semibold text-text">
                {title}
              </h4>
            ) : null}
            {description ? (
              <p className="mt-1 text-xs text-pretty text-text-tertiary">
                {description}
              </p>
            ) : null}
          </div>
          {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
        </div>
      ) : null}
      <div
        className={cn(
          (title || action) && "mt-2",
          surface === "card"
            ? "elevation-1 divide-y divide-border overflow-hidden rounded-[var(--radius-card)] bg-surface-card"
            : "space-y-3",
        )}
      >
        {children}
      </div>
    </section>
  );
}
