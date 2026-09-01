import type { Poll } from "@pqp/shared";
import { useEffect, useMemo, useState } from "react";
import coinHeadsUrl from "@/assets/chance/coin-heads.svg?url";
import { PollCard } from "@/components/chat/poll-card";
import { CornerCard } from "@/components/layout/corner-card";
import { Button } from "@/components/ui/button";
import { d6FaceUrl, playingCardUrl, polyhedralDieUrl } from "@/lib/chance-art";
import { isAutomatedBrowser } from "@/lib/hints";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  WHATS_NEW_PACK_ID,
  isWhatsNewSeen,
  rememberWhatsNew,
} from "@/lib/whats-new";

type WhatsNewSlideId = "chance" | "poll";

interface WhatsNewSlide {
  id: WhatsNewSlideId;
  titleKey: MessageKey;
  bodyKey: MessageKey;
}

const SLIDES: WhatsNewSlide[] = [
  {
    id: "chance",
    titleKey: "whatsNew.chance.title",
    bodyKey: "whatsNew.chance.body",
  },
  {
    id: "poll",
    titleKey: "whatsNew.poll.title",
    bodyKey: "whatsNew.poll.body",
  },
];

const PREVIEW_CLOSES_AT = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

const PREVIEW_VOTERS = {
  rafa: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    displayName: "Rafa",
    avatarUrl: null,
  },
  ana: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    displayName: "Ana",
    avatarUrl: null,
  },
  leo: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    displayName: "Leo",
    avatarUrl: null,
  },
} as const;

/**
 * "Dice and polls just landed", once, in the corner of `/app`.
 *
 * Same shape as the old Android beta card: no backdrop, no focus trap, nothing
 * blocked, Escape or the X closes it. A blocking dialog is for first-run. This
 * is a feature note, and it must not steal the composer.
 *
 * Each slide opens with a cropped product shot. Slack, Discord, and iOS What's
 * New all lead with the thing itself. A PNG would freeze last week's card
 * design; these are the live components and the live art.
 */
export function WhatsNewPrompt({ enabled = true }: { enabled?: boolean }) {
  const { t } = useTranslation();
  const [state] = useState(() => (isWhatsNewSeen() ? null : { pack: WHATS_NEW_PACK_ID }));
  const [open, setOpen] = useState(true);
  const [slide, setSlide] = useState(0);
  // Playwright sets this. A first-run card on every fresh context covers
  // the call stage and the composer the suite came to measure.
  const automated = isAutomatedBrowser();

  useEffect(() => {
    if (automated || !state || !enabled) {
      return;
    }
    rememberWhatsNew(state.pack);
  }, [automated, state, enabled]);

  const show = !automated && Boolean(state) && enabled && open;
  const current = SLIDES[slide]!;
  const last = slide >= SLIDES.length - 1;

  return (
    <CornerCard
      open={show}
      onClose={() => setOpen(false)}
      label={t("whatsNew.label")}
      dismissLabel={t("whatsNew.dismiss")}
      dataAttribute="whats-new"
      hero={
        <div key={current.id} className="animate-step-in">
          {current.id === "chance" ? <ChancePreview /> : <PollPreview />}
        </div>
      }
      title={t(current.titleKey)}
      body={t(current.bodyKey)}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-1.5" aria-hidden>
            {SLIDES.map((_, index) => (
              <span
                key={index}
                className={cn(
                  "h-1.5 rounded-full transition-all duration-300",
                  index === slide ? "w-4 bg-signal" : "w-1.5 bg-ink-4",
                )}
              />
            ))}
          </p>
          <Button
            size="sm"
            className="rounded-full px-4"
            onClick={() => {
              if (last) {
                setOpen(false);
                return;
              }
              setSlide((currentSlide) => currentSlide + 1);
            }}
          >
            {t(last ? "whatsNew.done" : "whatsNew.next")}
          </Button>
        </div>
      }
    />
  );
}

function ChancePreview() {
  const d20 = polyhedralDieUrl(20);
  const d6 = d6FaceUrl(6);
  const cards = ["AS", "KH", "QD"] as const;

  return (
    <div
      aria-hidden
      inert
      className="relative h-40 overflow-hidden bg-ink-1"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,color-mix(in_oklab,var(--color-signal)_16%,transparent),transparent_68%)]" />
      <div className="relative flex h-full items-end justify-center gap-1 px-3 pb-3">
        {d6 && (
          <img
            src={d6}
            alt=""
            className="mb-1 h-[3.25rem] w-[3.25rem] -rotate-12 drop-shadow-[var(--shadow-chance-piece)]"
          />
        )}
        {d20 && (
          <span className="relative mb-0.5 h-[4.25rem] w-[3.75rem] drop-shadow-[0_0_10px_color-mix(in_oklab,var(--color-signal)_70%,transparent)]">
            <img src={d20} alt="" className="h-full w-full" />
            <span className="absolute inset-0 flex items-center justify-center font-display text-xl font-extrabold tabular-nums text-[var(--color-die-ink-nat20)] [text-shadow:var(--shadow-die-face-text)]">
              20
            </span>
          </span>
        )}
        <img
          src={coinHeadsUrl}
          alt=""
          className="mb-2 h-14 w-14 rotate-6 drop-shadow-[var(--shadow-chance-piece)]"
        />
        <ul className="mb-1 ml-1 flex items-end">
          {cards.map((code, index) => {
            const art = playingCardUrl(code);
            const spread = index - (cards.length - 1) / 2;
            return (
              <li
                key={code}
                style={{
                  transform: `rotate(${spread * 8}deg) translateY(${Math.abs(spread) * 4}px)`,
                  zIndex: index,
                }}
                className={cn(
                  "relative h-[4.5rem] w-[3.1rem] origin-bottom drop-shadow-[var(--shadow-chance-piece)]",
                  index > 0 && "-ml-5",
                )}
              >
                {art ? (
                  <img src={art} alt="" className="h-full w-full object-contain" />
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-ink-2 to-transparent" />
    </div>
  );
}

/** A cropped poll card, the same object that lands in the transcript. */
function PollPreview() {
  const { t } = useTranslation();
  const poll = useMemo((): Poll => {
    const a = t("whatsNew.poll.preview.a");
    const b = t("whatsNew.poll.preview.b");
    const c = t("whatsNew.poll.preview.c");
    return {
      question: t("whatsNew.poll.preview.question"),
      allowMultiselect: false,
      closesAt: PREVIEW_CLOSES_AT,
      closedAt: null,
      totalVotes: 3,
      canClose: false,
      options: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
          label: a,
          votes: 2,
          voted: true,
          voters: [PREVIEW_VOTERS.rafa, PREVIEW_VOTERS.ana],
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
          label: b,
          votes: 1,
          voted: false,
          voters: [PREVIEW_VOTERS.leo],
        },
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
          label: c,
          votes: 0,
          voted: false,
          voters: [],
        },
      ],
    };
  }, [t]);

  return (
    <div aria-hidden inert className="relative overflow-hidden bg-ink-1 px-3 pb-3 pt-3">
      <div className="pointer-events-none select-none [&_[data-poll]]:mt-0">
        <PollCard poll={poll} onVote={() => {}} onClose={() => {}} />
      </div>
    </div>
  );
}
