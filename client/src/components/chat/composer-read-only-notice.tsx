import { Lock } from "lucide-react";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Where the composer would be, for a reader who may look but not send
 * (SEND_MESSAGES denied on the channel). Without it the box was there, the
 * message appeared, and a moment later the server answered "You don't have
 * permission to send here". Same dashed strip as a closed forum post, so the
 * two "no reply box" states look like one family.
 */
export function ComposerReadOnlyNotice({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-composer-readonly=""
      className={cn(
        "mx-3 mb-3 flex items-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border-strong px-3 py-2.5 text-sm text-text-secondary sm:mx-4",
        className,
      )}
    >
      <Lock className="h-4 w-4 shrink-0" aria-hidden />
      {t("chat.readOnly")}
    </div>
  );
}
