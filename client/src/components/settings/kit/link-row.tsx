import { ChevronRight, ExternalLink } from "lucide-react";
import {
  SETTINGS_INSET_FOCUS,
  SETTINGS_TRANSITION,
} from "@/components/settings/kit/classes";
import { useSettingsRow } from "@/components/settings/kit/use-settings-row";
import { cn } from "@/lib/utils";

export interface SettingsLinkRowProps {
  id: string;
  label: string;
  description?: string;
  /** A link. With `external`, opens in a new tab and shows `ExternalLink`. */
  href?: string;
  external?: boolean;
  /** An in-app jump, usually `openSection(...)`. Shows `ChevronRight`. */
  onClick?: () => void;
}

/** A row that goes somewhere. The whole row is the `<a>` or the `<button>`. */
export function SettingsLinkRow({
  id,
  label,
  description,
  href,
  external = false,
  onClick,
}: SettingsLinkRowProps) {
  useSettingsRow(id, label);
  const Icon = external ? ExternalLink : ChevronRight;
  const className = cn(
    "flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm text-text hover:bg-surface-2",
    description ? "min-h-12" : "min-h-11",
    SETTINGS_TRANSITION,
    SETTINGS_INSET_FOCUS,
  );
  const body = (
    <>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-pretty text-text-tertiary">
            {description}
          </span>
        ) : null}
      </span>
      <Icon aria-hidden className="h-4 w-4 shrink-0 text-text-tertiary" />
    </>
  );

  if (href) {
    return (
      <a
        data-settings-row={id}
        href={href}
        className={className}
        onClick={onClick}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      data-settings-row={id}
      className={className}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
