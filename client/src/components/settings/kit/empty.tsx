import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { IconSwap } from "@/components/ui/icon";

/**
 * An empty list inside a group: what is not here yet, quietly.
 *
 * `icon` is the Lucide glyph it draws with the toggle off; `glyph`, the
 * filled Phosphor one under the redesign. With no `glyph` the Lucide one
 * draws in both.
 */
export function SettingsEmpty({
  icon: Icon,
  glyph,
  title,
  description,
}: {
  icon?: LucideIcon;
  glyph?: PhosphorIcon;
  title: string;
  description?: string;
}) {
  return (
    <EmptyState
      size="inline"
      icon={
        Icon ? (
          glyph ? (
            <IconSwap off={Icon} on={glyph} size="md" offClassName="h-5 w-5" />
          ) : (
            <Icon className="h-5 w-5" />
          )
        ) : undefined
      }
      title={title}
      body={description}
      className="px-4 py-6"
      iconClassName="mb-2 flex text-text-tertiary"
      titleClassName="text-sm text-text-secondary"
      bodyClassName="mt-1 text-xs text-pretty text-text-tertiary"
    />
  );
}
