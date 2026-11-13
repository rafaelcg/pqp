import type { BauOffer, CommunityHomeLockedHint } from "@pqp/shared";
import {
  Clapperboard,
  FileText,
  Image as ImageIcon,
  Lock,
  Paperclip,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { formatBrl } from "@/lib/bau-plus/format";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The locked post when the server sells VIP (Baú+): Substack's and Patreon's
 * shape. Above it the post card already shows the title, the date and the
 * creator's own teaser (the "Prévia pra quem não é VIP" field of the
 * composer), and a plate shaped like the media when there is media. Here,
 * under the teaser: placeholder lines shaped like the hidden text, fading into
 * one card that says what is inside ("Vídeo", "3 min de leitura") and has one
 * button with the price.
 *
 * Honest by construction: the real body never reaches the client, and the
 * lines are plainly placeholders (bars, not blurred words), as many as the
 * text is long. What is inside comes from `post.lockedHint`, which the API
 * fills only for a locked reader and which carries no word of the post.
 *
 * NEVER A DISABLED BUTTON. The only states are "Apoiar por R$ X/mês", "Continuar
 * o pagamento" (a Pix is already open) and, for somebody whose VIP ran out,
 * "Voltar pro VIP". The lines are decoration (`aria-hidden`); the card is a
 * labelled group whose button is described by the sentence above it.
 */

/**
 * The placeholder paragraph: each line is a row of word-sized bars (relative
 * widths), so it reads as text that is redacted, not as a page loading.
 * Fixed, so every locked post draws the same shapes and nothing is derived
 * from the hidden words.
 */
const LINES: number[][] = [
  [9, 14, 6, 11, 17, 8, 12, 5, 10],
  [12, 7, 15, 9, 6, 13, 10, 16],
  [6, 11, 8, 14, 12, 7, 17, 9],
  [15, 9, 12, 6, 10, 13, 8, 11],
  [10, 13, 7, 16, 9],
];

/**
 * How many lines: none for media with at most a caption (the plate above
 * already has the shape of the thing), otherwise more for a longer read. An
 * older API sends no hint: three lines.
 */
function linesFor(hint: CommunityHomeLockedHint | null | undefined): number {
  if (!hint) return 3;
  if (hint.readMinutes === 0) return 0;
  if (hint.mediaKind && hint.readMinutes <= 1) return 0;
  if (hint.readMinutes === 1) return 3;
  if (hint.readMinutes === 2) return 4;
  return 5;
}

const KIND: Record<
  NonNullable<CommunityHomeLockedHint["mediaKind"]>,
  { icon: LucideIcon; label: MessageKey }
> = {
  image: { icon: ImageIcon, label: "bauPlus.paywall.kind.image" },
  video: { icon: Clapperboard, label: "bauPlus.paywall.kind.video" },
  youtube: { icon: Clapperboard, label: "bauPlus.paywall.kind.video" },
  twitch: { icon: Clapperboard, label: "bauPlus.paywall.kind.video" },
  tiktok: { icon: Clapperboard, label: "bauPlus.paywall.kind.video" },
  instagram: { icon: ImageIcon, label: "bauPlus.paywall.kind.instagram" },
  file: { icon: Paperclip, label: "bauPlus.paywall.kind.file" },
};

export function BauPlusPaywall({
  offer,
  serverName,
  hint,
  onStart,
  onView,
}: {
  offer: BauOffer;
  serverName: string;
  /** `post.lockedHint`: what the lock may say about what it hides. */
  hint?: CommunityHomeLockedHint | null;
  onStart: () => void;
  /** Drawn once with a live button; for the funnel counter. */
  onView?: () => void;
}) {
  const { t, locale } = useTranslation();
  const headingId = useId();
  const bodyId = useId();
  const viewed = useRef(false);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    if (!viewed.current) {
      viewed.current = true;
      onViewRef.current?.();
    }
  }, []);

  if (!offer.plan) {
    return null;
  }
  const price = formatBrl(offer.plan.priceCents, locale);
  const membership = offer.membership;
  const pending = Boolean(membership?.pendingAttempt);
  const lapsed =
    membership?.status === "expired" ||
    membership?.status === "cancelled" ||
    membership?.status === "refunded";

  const cta = pending
    ? t("bauPlus.paywall.continue")
    : lapsed
      ? t("bauPlus.paywall.comeBack", { price })
      : t("bauPlus.paywall.cta", { price });

  const lines = linesFor(hint);
  const inside: { icon: LucideIcon; label: string }[] = [];
  if (hint?.mediaKind) {
    const kind = KIND[hint.mediaKind];
    inside.push({ icon: kind.icon, label: t(kind.label) });
  }
  // A caption under a video is not "a read": the length is said only when
  // the text is the point.
  if (hint && hint.readMinutes > 0 && !(hint.mediaKind && hint.readMinutes <= 1)) {
    inside.push({
      icon: FileText,
      label: t("bauPlus.paywall.readMinutes", { count: hint.readMinutes }),
    });
  }

  return (
    <div className="mt-3" data-home-unlock-cta data-bau-paywall>
      {lines > 0 && (
        <div
          aria-hidden
          className="bau-lock-lines flex flex-col gap-3 pb-8 pt-2"
          data-bau-lock-lines={lines}
        >
          {LINES.slice(LINES.length - lines).map((words, line) => (
            <span key={line} className="flex gap-1.5 overflow-hidden">
              {words.map((grow, word) => (
                <span
                  key={word}
                  className="block h-2.5 min-w-[1.25rem] rounded-full bg-surface-3"
                  style={{ flexGrow: grow, flexBasis: 0 }}
                />
              ))}
            </span>
          ))}
        </div>
      )}
      <div
        role="group"
        aria-labelledby={headingId}
        className={cn(
          "elevation-1 relative rounded-[var(--radius-card)] bg-surface-card p-4 sm:p-5",
          lines > 0 ? "-mt-6" : "mt-1",
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
            <Lock aria-hidden className="h-3.5 w-3.5" />
          </span>
          <p
            id={headingId}
            className="min-w-0 font-display text-base font-bold leading-6 text-text sm:text-lg"
          >
            {t("bauPlus.paywall.title")}
          </p>
        </div>
        {inside.length > 0 && (
          <p
            className="mt-3 flex flex-wrap items-center gap-1.5"
            data-bau-lock-inside
          >
            <span className="sr-only">{t("bauPlus.paywall.insideLabel")}</span>
            {inside.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-xs font-medium text-text-secondary"
              >
                <Icon aria-hidden className="h-3.5 w-3.5" />
                {label}
              </span>
            ))}
          </p>
        )}
        <p
          id={bodyId}
          className="mt-3 max-w-[34rem] text-pretty text-sm leading-6 text-text-secondary"
        >
          {pending
            ? t("bauPlus.paywall.pendingBody")
            : t("bauPlus.paywall.body", { server: serverName })}
        </p>
        <div className="mt-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
          <Button
            // Wraps instead of clipping: "Voltar pro VIP por R$ 9,90/mês" is
            // wider than a phone's card.
            className="h-auto min-h-11 w-full whitespace-normal px-5 py-2.5 text-[15px] leading-5 text-balance sm:w-auto"
            onClick={onStart}
            aria-describedby={bodyId}
            data-bau-paywall-cta
          >
            {cta}
          </Button>
          <p className="text-center text-[13px] leading-5 text-text-tertiary sm:text-left">
            {t("bauPlus.paywall.fine")}
          </p>
        </div>
      </div>
    </div>
  );
}
