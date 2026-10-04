import { CircleCheck, CircleX, Info, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONE = {
  success: { icon: CircleCheck, className: "text-success" },
  danger: { icon: CircleX, className: "text-danger" },
  info: { icon: Info, className: "text-text-tertiary" },
} as const;

export interface SettingsResultProps {
  tone: "success" | "danger" | "info";
  /** One line: what happened ("Recebido. Obrigado!"). */
  title: string;
  description?: ReactNode;
  /** One button for what comes next ("Enviar outro"). */
  action?: ReactNode;
  /** Replaces the tone's icon. */
  icon?: LucideIcon;
}

/**
 * The outcome of a one-shot action, standing in for the form that produced it:
 * Feedback after a send. A tone icon, one line, and an optional next step,
 * centred like `SettingsEmpty`. Put it inside a `SettingsGroup`.
 *
 * Not a live region: one that mounts already holding its text is announced
 * unreliably. Move focus to the action (`Button` forwards its ref) or to the
 * title, which takes `tabIndex={-1}` for exactly that.
 */
export function SettingsResult({
  tone,
  title,
  description,
  action,
  icon,
}: SettingsResultProps) {
  const { icon: toneIcon, className } = TONE[tone];
  const Icon = icon ?? toneIcon;
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
      <Icon aria-hidden className={cn("h-5 w-5", className)} />
      <div>
        <p
          tabIndex={-1}
          data-settings-result-title=""
          className="text-sm text-text focus-visible:outline-none"
        >
          {title}
        </p>
        {description ? (
          <p className="mt-1 text-xs text-pretty text-text-tertiary">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
