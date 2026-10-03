import type { LucideIcon } from "lucide-react";

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
    <div className="flex flex-col items-center px-4 py-6 text-center">
      {Icon ? <Icon aria-hidden className="mb-2 h-5 w-5 text-text-tertiary" /> : null}
      <p className="text-sm text-text-secondary">{title}</p>
      {description ? (
        <p className="mt-1 text-xs text-pretty text-text-tertiary">{description}</p>
      ) : null}
    </div>
  );
}
