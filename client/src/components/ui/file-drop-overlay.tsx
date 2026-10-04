import { cn } from "@/lib/utils";

/**
 * The veil over a drop zone while a file is dragged across it.
 *
 * `accept` says where the file will go; `refuse` says why it will not, in the
 * same place and the same shape, so a person is told BEFORE letting go rather
 * than after. It is inert (`pointer-events-none`): the drop has to land on the
 * zone underneath, and an overlay that takes the events would also fire
 * `dragleave` on the zone the instant it appeared.
 *
 * Decorative. A screen-reader or keyboard user has the attach button, which
 * stays the accessible path; announcing a drag target that only a pointer can
 * reach would be noise, hence `aria-hidden`. The fade is `animate-fade-in`,
 * which `index.css` already switches off under `prefers-reduced-motion`.
 */
export function FileDropOverlay({
  tone = "accept",
  label,
  size = "pane",
  className,
}: {
  tone?: "accept" | "refuse";
  label: string;
  /** `pane` fills a conversation; `field` hugs a picker or a form control. */
  size?: "pane" | "field";
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-file-drop-overlay={tone}
      className={cn(
        "pointer-events-none absolute inset-0 z-30 flex animate-fade-in items-center justify-center border-2 border-dashed text-center",
        size === "pane"
          ? "m-2 rounded-[var(--radius-card)]"
          : "rounded-[var(--radius-control)] px-2",
        tone === "accept"
          ? "border-accent bg-surface-0/85"
          : "border-border-strong bg-surface-0/90",
        className,
      )}
    >
      <p
        className={cn(
          "font-display font-bold",
          size === "pane" ? "px-4 text-lg" : "text-xs",
          tone === "accept" ? "text-accent" : "text-text-secondary",
        )}
      >
        {label}
      </p>
    </div>
  );
}
