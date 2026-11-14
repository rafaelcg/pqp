import type { ReactNode, Ref } from "react";
import { PaneHeader } from "@/components/ui/section-header";

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
    <PaneHeader
      title={title}
      description={description}
      actions={actions}
      actionsRef={actionsRef}
      className="mb-8 gap-4"
      titleClassName="font-display text-xl font-bold text-text"
      descriptionClassName="mt-1 text-sm text-pretty text-text-secondary"
    />
  );
}
