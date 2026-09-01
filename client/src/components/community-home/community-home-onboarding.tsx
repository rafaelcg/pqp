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
import { useEffect, useRef } from "react";
import demoPosterEn from "@/assets/bau/bau-demo.en.jpg?url";
import demoMp4En from "@/assets/bau/bau-demo.en.mp4?url";
import demoWebmEn from "@/assets/bau/bau-demo.en.webm?url";
import demoPosterPt from "@/assets/bau/bau-demo.pt-BR.jpg?url";
import demoMp4Pt from "@/assets/bau/bau-demo.pt-BR.mp4?url";
import demoWebmPt from "@/assets/bau/bau-demo.pt-BR.webm?url";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The two ways Baú explains itself, both inside the feed and both quiet.
 *
 * WHY IN THE FEED AND NOT A TOUR. A modal over an empty feed teaches the
 * layout of a room nobody has posted in yet. The intro sits where the posts
 * will be, says what the surface is in three lines, and goes away for good on
 * one click (a preference, so a new browser does not re-offer it).
 *
 * WHY TWO CARDS. A member needs to know what this is and what they can do
 * here (like, comment, nothing else). An owner needs to be sold on it: what
 * to put in, why it beats #avisos, what it looks like with a week of posts in
 * it. That second card leads with a short recording of a filled Baú, because
 * an empty feed cannot show what a full one feels like, and a screenshot
 * would freeze last week's card design. The recording is made by
 * `client/e2e` tooling from seeded posts, one per language.
 */

interface Row {
  icon: typeof Heart;
  title: MessageKey;
  body: MessageKey;
}

function RowList({ rows, large }: { rows: Row[]; large: boolean }) {
  const { t } = useTranslation();
  return (
    <ul className={cn("grid gap-3", large && "sm:grid-cols-2 sm:gap-4")}>
      {rows.map((row) => {
        const Icon = row.icon;
        return (
          <li key={row.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "flex shrink-0 items-center justify-center rounded-xl border border-ink-4 bg-ink text-signal",
                large ? "h-12 w-12" : "mt-0.5 h-8 w-8 rounded-full",
              )}
            >
              <Icon className={large ? "h-6 w-6" : "h-4 w-4"} />
            </span>
            <div className="min-w-0">
              <p className={cn("font-semibold", large ? "text-base" : "text-sm")}>
                {t(row.title)}
              </p>
              <p className={cn("text-paper-muted", large ? "text-sm" : "text-xs")}>
                {t(row.body)}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const MEMBER_ROWS: Row[] = [
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

const MEMBER_VIP_ROW: Row = {
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
  const rows = vipEnabled ? [...MEMBER_ROWS, MEMBER_VIP_ROW] : MEMBER_ROWS;
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
      <RowList rows={rows} large={false} />
      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          {t("communityHome.intro.ok")}
        </Button>
      </div>
    </section>
  );
}

const STAFF_ROWS: Row[] = [
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
    icon: Heart,
    title: "communityHome.guide.react.title",
    body: "communityHome.guide.react.body",
  },
  {
    icon: CalendarClock,
    title: "communityHome.guide.schedule.title",
    body: "communityHome.guide.schedule.body",
  },
];

const STAFF_VIP_ROW: Row = {
  icon: Lock,
  title: "communityHome.guide.vip.title",
  body: "communityHome.guide.vip.body",
};

/**
 * The recording of a filled Baú. Muted, looping, `playsInline`, no controls:
 * a product shot that moves, not a video player. Autoplay is skipped under
 * `prefers-reduced-motion`, where the poster frame stands on its own.
 */
function DemoReel() {
  const { t, locale } = useTranslation();
  const ref = useRef<HTMLVideoElement>(null);
  const pt = locale === "pt-BR";

  useEffect(() => {
    const video = ref.current;
    if (!video) {
      return;
    }
    const still =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      video.pause();
      return;
    }
    void video.play().catch(() => {
      // Autoplay refused: the poster stays, which is fine.
    });
  }, []);

  return (
    <figure className="overflow-hidden rounded-xl border border-ink-4 bg-ink" data-home-guide-demo>
      <video
        ref={ref}
        className="block aspect-[952/800] w-full"
        muted
        loop
        playsInline
        preload="metadata"
        poster={pt ? demoPosterPt : demoPosterEn}
        aria-label={t("communityHome.guide.demoLabel")}
      >
        <source src={pt ? demoWebmPt : demoWebmEn} type="video/webm" />
        <source src={pt ? demoMp4Pt : demoMp4En} type="video/mp4" />
      </video>
      <figcaption className="border-t border-ink-4 px-3 py-1.5 text-[11px] text-paper-muted">
        {t("communityHome.guide.demoLabel")}
      </figcaption>
    </figure>
  );
}

/**
 * What an owner sees instead of an empty feed, and again (collapsed to the
 * rows) at the top of Compose until the first post exists.
 */
export function CommunityHomeStaffGuide({
  variant,
  vipEnabled,
  onCompose,
}: {
  variant: "empty" | "compose";
  vipEnabled: boolean;
  onCompose?: () => void;
}) {
  const { t } = useTranslation();
  const rows = vipEnabled ? [...STAFF_ROWS, STAFF_VIP_ROW] : STAFF_ROWS;

  if (variant === "compose") {
    return (
      <section
        data-home-staff-guide="compose"
        className="rounded-xl border border-dashed border-signal/40 bg-ink-3/30 p-4"
      >
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-paper-muted">
          {t("communityHome.guide.composeTitle")}
        </p>
        <RowList rows={rows} large={false} />
      </section>
    );
  }

  return (
    <section
      data-home-staff-guide="empty"
      className="animate-rise overflow-hidden rounded-2xl border border-signal/30 bg-[radial-gradient(120%_80%_at_0%_0%,var(--glow-accent-soft),transparent_55%)] bg-ink-3/30"
    >
      <div className="p-5 sm:p-6">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-signal">
          {t("communityHome.title")}
        </p>
        <h2 className="font-display text-2xl font-bold leading-tight sm:text-3xl">
          {t("communityHome.guide.emptyTitle")}
        </h2>
        <p className="mt-2 max-w-prose text-sm text-paper-muted sm:text-base">
          {t("communityHome.guide.emptyLead")}
        </p>
      </div>

      <div className="px-5 sm:px-6">
        <DemoReel />
      </div>

      <div className="p-5 sm:p-6">
        <RowList rows={rows} large />
        <p className="mt-5 text-xs text-paper-muted">
          {t("communityHome.guide.notAvisos")}
        </p>
        {onCompose && (
          <div className="mt-4">
            <Button onClick={onCompose} data-home-guide-compose>
              <PenLine className="mr-2 h-4 w-4" aria-hidden />
              {t("communityHome.guide.cta")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
