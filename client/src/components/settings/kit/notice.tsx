import {
  CheckCircle,
  Info as InfoFill,
  Warning,
  XCircle,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import {
  settingsPaneSettled,
  useSettingsAnnounce,
} from "@/components/settings/kit/announcer";
import { IconSwap } from "@/components/ui/icon";
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
  /** The redesign's glyph for `icon` (Phosphor, filled). Without it the
   *  tone's own glyph stands in, so a line icon never sits beside the filled
   *  ones. */
  glyph?: PhosphorIcon;
  /**
   * The live role. Default: `alert` for danger, `status` otherwise. `alert`
   * for a refusal that answers an action the person just took (it is read at
   * once). `note` for a notice that is just there when the tab opens and must
   * not be announced as news.
   */
  role?: "status" | "alert" | "note";
}

const TONE: Record<
  SettingsNoticeProps["tone"],
  { icon: LucideIcon; glyph: PhosphorIcon; className: string }
> = {
  info: { icon: Info, glyph: InfoFill, className: "text-text-secondary" },
  warning: {
    icon: TriangleAlert,
    glyph: Warning,
    className: "bg-warning-soft text-on-warning-soft",
  },
  danger: { icon: CircleX, glyph: XCircle, className: "bg-danger-soft text-on-danger-soft" },
  success: {
    icon: CircleCheck,
    glyph: CheckCircle,
    className: "bg-success-soft text-on-success-soft",
  },
};

/**
 * A state, not content: a permission that is missing, a capability this device
 * lacks, a feature this server has not configured. Every tinted tone is a soft
 * fill with its own `on-` foreground, a pair the bench measures; info is a plain
 * outline on the surface it sits on, because text-secondary on that surface is
 * measured too. Under the redesign info is a borderless tint instead
 * (`--settings-notice-info-bg`: text at 6% in dark, 4% in light).
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
  glyph: customGlyph,
  role,
}: SettingsNoticeProps) {
  const { icon: toneIcon, glyph: toneGlyph, className } = TONE[tone];
  const glyph = customGlyph ?? toneGlyph;
  const Icon = icon ?? toneIcon;
  const live = role ?? (tone === "danger" ? "alert" : "status");
  // Inside Settings a live notice speaks through the dialog's announcer: a
  // region inserted already holding its text is often not read. It is said
  // when it appears after the tab opened and whenever its text changes; one
  // that was there when the tab opened is content, read in the page.
  const announce = useSettingsAnnounce();
  const speaks = announce !== null && live !== "note";
  const textRef = useRef<HTMLDivElement>(null);
  const spoken = useRef<string | null>(null);
  useEffect(() => {
    if (!speaks) {
      return;
    }
    const text = textRef.current?.textContent?.trim() ?? "";
    if (spoken.current === null) {
      spoken.current = text;
      // An explicit `role` says the notice answers something that just
      // happened (a provider's error on return, a refused close), so it is
      // said even when it arrives with the tab.
      if (text && (role !== undefined || settingsPaneSettled())) {
        announce(text, { combine: true });
      }
      return;
    }
    if (text && text !== spoken.current) {
      spoken.current = text;
      announce(text, { combine: true });
    }
  });
  return (
    <div
      role={speaks ? undefined : live}
      className={cn(
        "flex items-start gap-3 px-4 py-3 text-xs",
        className,
        inGroup
          ? "rounded-none"
          : cn(
              "rounded-[var(--radius-card)]",
              tone === "info" && "border border-border",
              // Under the redesign a notice on its own is a banner's inset
              // card; info is a quiet tint, not an outline that reads as an
              // empty field.
              "redesign:rounded-[var(--banner-radius)]",
              tone === "info" &&
                "redesign:border-transparent redesign:bg-[color:var(--settings-notice-info-bg)]",
              // A tinted notice takes the banner's tone edge, so a notice and
              // a `ui/Banner` of the same tone match.
              tone === "warning" &&
                "redesign:border redesign:border-[color:color-mix(in_oklab,var(--color-warning)_var(--banner-edge),transparent)]",
              tone === "danger" &&
                "redesign:border redesign:border-[color:color-mix(in_oklab,var(--color-danger)_var(--banner-edge),transparent)]",
              tone === "success" &&
                "redesign:border redesign:border-[color:color-mix(in_oklab,var(--color-success)_var(--banner-edge),transparent)]",
            ),
        "redesign:gap-2.5",
      )}
    >
      <IconSwap off={Icon} on={glyph} offClassName="mt-px h-4 w-4 shrink-0" className="mt-px" />
      <div ref={textRef} className="min-w-0 flex-1 text-pretty">
        {title ? <p className="text-sm font-medium redesign:font-semibold">{title}</p> : null}
        <div className={title ? "mt-0.5" : undefined}>{children}</div>
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}
