import {
  CalendarClock,
  Clapperboard,
  FileText,
  Heart,
  Lock,
  MessageCircle,
  PenLine,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * The two ways Baú explains itself, both inside the feed and both quiet.
 *
 * WHY IN THE FEED AND NOT A TOUR. A modal over an empty feed teaches the
 * layout of a room nobody has posted in yet. The intro sits where the posts
 * will be, says what the surface is in three lines, and goes away for good on
 * one click (a preference, so a new browser does not re-offer it).
 *
 * WHY TWO CARDS. A member needs to know what this is and what they can do
 * here (like, comment, nothing else). An owner needs to know what to put in
 * it and why it beats #avisos: that is a different sentence, and it gets the
 * empty state and the composer rather than a card the member also reads.
 */

interface IntroRow {
  icon: typeof Heart;
  title: MessageKey;
  body: MessageKey;
}

const MEMBER_ROWS: IntroRow[] = [
  {
    icon: Clapperboard,
    title: "communityHome.intro.posts.title",
    body: "communityHome.intro.posts.body",
  },
  {
    icon: Heart,
    title: "communityHome.intro.react.title",
    body: "communityHome.intro.react.body",
  },
  {
    icon: MessageCircle,
    title: "communityHome.intro.comments.title",
    body: "communityHome.intro.comments.body",
  },
];

const VIP_ROW: IntroRow = {
  icon: Lock,
  title: "communityHome.intro.vip.title",
  body: "communityHome.intro.vip.body",
};

export function CommunityHomeIntroCard({
  serverName,
  vipEnabled,
  onDismiss,
}: {
  serverName: string;
  vipEnabled: boolean;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const rows = vipEnabled ? [...MEMBER_ROWS, VIP_ROW] : MEMBER_ROWS;
  return (
    <section
      data-home-intro
      aria-labelledby="home-intro-title"
      className="animate-rise rounded-xl border border-ink-4 bg-ink-3/40 p-4 sm:p-5"
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id="home-intro-title"
            className="font-display text-lg font-bold leading-tight"
          >
            {t("communityHome.intro.title", { name: serverName })}
          </h2>
          <p className="mt-1 text-sm text-paper-muted">
            {t("communityHome.intro.lead")}
          </p>
        </div>
        <button
          type="button"
          data-home-intro-dismiss
          onClick={onDismiss}
          aria-label={t("communityHome.intro.dismiss")}
          title={t("communityHome.intro.dismiss")}
          className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-paper-muted transition-colors hover:bg-ink-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <ul className="space-y-2.5">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <li key={row.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-4 bg-ink text-signal"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t(row.title)}</p>
                <p className="text-xs text-paper-muted">{t(row.body)}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          {t("communityHome.intro.ok")}
        </Button>
      </div>
    </section>
  );
}

interface GuideRow {
  icon: typeof PenLine;
  title: MessageKey;
  body: MessageKey;
}

const STAFF_ROWS: GuideRow[] = [
  {
    icon: Clapperboard,
    title: "communityHome.guide.clip.title",
    body: "communityHome.guide.clip.body",
  },
  {
    icon: FileText,
    title: "communityHome.guide.file.title",
    body: "communityHome.guide.file.body",
  },
  {
    icon: CalendarClock,
    title: "communityHome.guide.schedule.title",
    body: "communityHome.guide.schedule.body",
  },
];

/**
 * What an owner sees instead of an empty feed, and again (collapsed to the
 * rows) at the top of Compose until the first post exists.
 */
export function CommunityHomeStaffGuide({
  variant,
  onCompose,
}: {
  variant: "empty" | "compose";
  onCompose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      data-home-staff-guide={variant}
      className="rounded-xl border border-dashed border-signal/40 bg-ink-3/30 p-4 sm:p-5"
    >
      {variant === "empty" && (
        <>
          <h2 className="font-display text-lg font-bold leading-tight">
            {t("communityHome.guide.emptyTitle")}
          </h2>
          <p className="mt-1 mb-4 text-sm text-paper-muted">
            {t("communityHome.guide.emptyLead")}
          </p>
        </>
      )}
      {variant === "compose" && (
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {t("communityHome.guide.composeTitle")}
        </p>
      )}
      <ul className="space-y-2.5">
        {STAFF_ROWS.map((row) => {
          const Icon = row.icon;
          return (
            <li key={row.title} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ink-4 bg-ink text-signal"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t(row.title)}</p>
                <p className="text-xs text-paper-muted">{t(row.body)}</p>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-paper-muted">
        {t("communityHome.guide.notAvisos")}
      </p>
      {variant === "empty" && onCompose && (
        <div className="mt-4">
          <Button size="sm" onClick={onCompose} data-home-guide-compose>
            <PenLine className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {t("communityHome.guide.cta")}
          </Button>
        </div>
      )}
    </section>
  );
}
