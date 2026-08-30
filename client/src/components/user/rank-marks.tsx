import { Bot, Briefcase, Crown, Shield, ShieldCheck, Star } from "lucide-react";
import type { IdentityMark } from "@/lib/author-display";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const MARK: Record<
  IdentityMark,
  { icon: typeof Crown; label: MessageKey; solid: boolean }
> = {
  // Crown and shields read as silhouettes, so the card fills them. The bot
  // glyph is drawn with inner strokes and stays an outline at every size.
  owner: { icon: Crown, label: "chat.badge.owner", solid: true },
  admin: { icon: Shield, label: "chat.badge.admin", solid: true },
  manager: { icon: Briefcase, label: "chat.badge.manager", solid: true },
  moderator: { icon: ShieldCheck, label: "chat.badge.moderator", solid: true },
  vip: { icon: Star, label: "chat.badge.vip", solid: true },
  bot: { icon: Bot, label: "chat.badge.bot", solid: false },
};

/**
 * The glyphs beside a name: owner crown, admin shield, then manager,
 * moderator, VIP, and a bot mark for character accounts. Same marks
 * everywhere, at two densities. Chat and the member list keep the default
 * quiet 12px outline; the profile card asks for `size="card"`, a 16px solid
 * accent glyph, because next to a 20px bold name the quiet version
 * disappeared and promoting somebody looked like nothing.
 */
export function RankMarks({
  marks,
  className,
  size = "xs",
}: {
  marks: readonly IdentityMark[];
  className?: string;
  size?: "xs" | "card";
}) {
  const { t } = useTranslation();
  if (marks.length === 0) {
    return null;
  }
  const card = size === "card";
  return (
    <>
      {marks.map((mark) => {
        const { icon: Icon, label, solid } = MARK[mark];
        return (
          <span
            key={mark}
            className={cn(
              "inline-flex shrink-0 items-center",
              card ? "text-signal" : "text-paper-muted",
              className,
            )}
            title={t(label)}
            data-rank-mark={mark}
          >
            <Icon
              className={card ? "h-4 w-4" : "h-3 w-3"}
              aria-hidden
              {...(card && solid
                ? { fill: "currentColor", strokeWidth: 1 }
                : {})}
            />
            <span className="sr-only">{t(label)}</span>
          </span>
        );
      })}
    </>
  );
}
