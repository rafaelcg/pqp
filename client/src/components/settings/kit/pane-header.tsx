import type { ReactNode, Ref } from "react";

/**
 * The pane's title, its one-line description and the header actions.
 *
 * The shell renders it from the section's own label and description, so the
 * `h3` always reads the tab's name. Tabs add buttons through
 * `SettingsHeaderActions`, which lands in `actionsRef`; `actions` is for a
 * caller that owns the header outright (the `/qa/ui` sheet).
 */
export function SettingsPaneHeader({
  title,
  description,
  actions,
  actionsRef,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  actionsRef?: Ref<HTMLDivElement>;
}) {
  return (
    <header className="mb-8 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="font-display text-xl font-bold text-text">{title}</h3>
        {description ? (
          <p className="mt-1 text-sm text-pretty text-text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {/* Empty until a tab portals something in; `empty:hidden` keeps an
          empty slot from claiming the gap. */}
      <div
        ref={actionsRef}
        className="flex shrink-0 items-center gap-2 empty:hidden"
      >
        {actions}
      </div>
    </header>
  );
}
