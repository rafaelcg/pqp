import {
  History,
  MessageSquare,
  Users,
  Video,
  Zap,
} from "lucide-react";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The five things a watch party is, said once and shown in two places: the
 * in-app waitlist dialog and the public `/watch-party` page.
 */
type Feature = {
  icon: typeof Users;
  title: MessageKey;
  body: MessageKey;
};

const FEATURES: Feature[] = [
  {
    icon: Users,
    title: "watchParty.waitlist.feature.audience.title",
    body: "watchParty.waitlist.feature.audience.body",
  },
  {
    icon: Zap,
    title: "watchParty.waitlist.feature.latency.title",
    body: "watchParty.waitlist.feature.latency.body",
  },
  {
    icon: Video,
    title: "watchParty.waitlist.feature.camera.title",
    body: "watchParty.waitlist.feature.camera.body",
  },
  {
    icon: MessageSquare,
    title: "watchParty.waitlist.feature.chat.title",
    body: "watchParty.waitlist.feature.chat.body",
  },
  {
    icon: History,
    title: "watchParty.waitlist.feature.replay.title",
    body: "watchParty.waitlist.feature.replay.body",
  },
];

/** The five things a watch party is, in one list. Shared with the public page. */
export function WatchPartyFeatureList({
  className,
  columns = 2,
}: {
  className?: string;
  columns?: 2 | 3;
}) {
  const { t } = useTranslation();
  return (
    <ul
      className={cn(
        "grid grid-cols-1 gap-x-5 gap-y-3",
        columns === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2",
        className,
      )}
    >
      {FEATURES.map((feature) => (
        <li key={feature.title} className="flex gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft">
            <feature.icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text">
              {t(feature.title)}
            </span>
            <span className="block text-pretty text-xs leading-relaxed text-text-secondary">
              {t(feature.body)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

