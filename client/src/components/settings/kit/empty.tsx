import type { LucideIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/** An empty list inside a group: what is not here yet, quietly. */
export function SettingsEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <EmptyState
      size="inline"
      icon={Icon ? <Icon className="h-5 w-5" /> : undefined}
      title={title}
      body={description}
      className="px-4 py-6"
      iconClassName="mb-2 flex text-text-tertiary"
      titleClassName="text-sm text-text-secondary"
      bodyClassName="mt-1 text-xs text-pretty text-text-tertiary"
    />
  );
}
