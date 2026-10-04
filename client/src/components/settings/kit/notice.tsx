import {
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsNoticeProps {
  tone: "info" | "warning" | "danger" | "success";
  title?: string;
  children: ReactNode;
  /** One secondary `sm` button. */
  action?: ReactNode;
  /**
   * Inside a `SettingsGroup` the notice is a row: square corners, no border of
   * its own, the group's divider above and below it.
   */
  inGroup?: boolean;
  /** Replaces the tone's icon (a `Bug` on the Feedback badge notice). */
  icon?: LucideIcon;
  /**
   * The live role. Default: `alert` for danger, `status` otherwise. `alert`
   * for a refusal that answers an action the person just took (it is read at
   * once). `note` for a notice that is just there when the tab opens and must
   * not be announced as news.
   */
  role?: "status" | "alert" | "note";
}

const TONE = {
  info: { icon: Info, className: "text-text-secondary" },
  warning: { icon: TriangleAlert, className: "bg-warning-soft text-on-warning-soft" },
  danger: { icon: CircleX, className: "bg-danger-soft text-on-danger-soft" },
  success: { icon: CircleCheck, className: "bg-success-soft text-on-success-soft" },
} as const;

/**
 * A state, not content: a permission that is missing, a capability this device
 * lacks, a feature this server has not configured. Every tinted tone is a soft
 * fill with its own `on-` foreground, a pair the bench measures; info is a plain
 * outline on the surface it sits on, because text-secondary on that surface is
 * measured too.
 *
 * In a group the notice sets no border of its own at all: a `border-0` there
 * used to zero the `divide-y` line the group draws under it.
 */
export function SettingsNotice({
  tone,
  title,
  children,
  action,
  inGroup = false,
  icon,
  role,
}: SettingsNoticeProps) {
  const { icon: toneIcon, className } = TONE[tone];
  const Icon = icon ?? toneIcon;
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn(
        "flex items-start gap-3 px-4 py-3 text-xs",
        className,
        inGroup
          ? "rounded-none"
          : cn(
              "rounded-[var(--radius-card)]",
              tone === "info" && "border border-border",
            ),
      )}
    >
      <Icon aria-hidden className="mt-px h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-pretty">
        {title ? <p className="text-sm font-medium">{title}</p> : null}
        <div className={title ? "mt-0.5" : undefined}>{children}</div>
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
