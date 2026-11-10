import type { JamInstrument, JamContributor } from "@pqp/shared";
import { Check, Plus, Users } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK, JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import type { JamNeed } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { useNeedLabel } from "./jam-need";

/**
 * The jam's own look, shared by the wall, the song and the studio: a song's
 * cover is a gradient through the colours of the instruments that are ON it
 * (so the art says who is in the band before a word is read), the loudest
 * stem's waveform mirrored across it, and the band strip, one dot per
 * instrument with the missing ones dashed. Every colour is a role token; the
 * class names are written out because Tailwind reads the source.
 */

const FROM: Record<JamInstrument, string> = {
  guitar: "from-inst-guitar",
  bass: "from-inst-bass",
  drums: "from-inst-drums",
  vocals: "from-inst-vocals",
  keys: "from-inst-keys",
  other: "from-inst-other",
};
const VIA: Record<JamInstrument, string> = {
  guitar: "via-inst-guitar",
  bass: "via-inst-bass",
  drums: "via-inst-drums",
  vocals: "via-inst-vocals",
  keys: "via-inst-keys",
  other: "via-inst-other",
};
const TO: Record<JamInstrument, string> = {
  guitar: "to-inst-guitar",
  bass: "to-inst-bass",
  drums: "to-inst-drums",
  vocals: "to-inst-vocals",
  keys: "to-inst-keys",
  other: "to-inst-other",
};
const RING: Record<JamInstrument, string> = {
  guitar: "ring-inst-guitar",
  bass: "ring-inst-bass",
  drums: "ring-inst-drums",
  vocals: "ring-inst-vocals",
  keys: "ring-inst-keys",
  other: "ring-inst-other",
};
export const INST_RING = RING;

/** The instruments on a song in the band's order, the colours of its cover. */
export function bandOrder(instruments: readonly JamInstrument[]): JamInstrument[] {
  return JAM_INSTRUMENT_ORDER.filter((one) => instruments.includes(one));
}

/** The gradient classes for a cover: one instrument is a single colour with depth. */
export function coverGradient(instruments: readonly JamInstrument[]): string {
  const band = bandOrder(instruments);
  const [a = "other", b, c] = band;
  if (!b) {
    return cn("bg-gradient-to-br", FROM[a], TO[a]);
  }
  if (!c) {
    return cn("bg-gradient-to-br", FROM[a], TO[b]);
  }
  return cn("bg-gradient-to-br", FROM[a], VIA[b], TO[c]);
}

/** Bars mirrored around the middle line: the cover's waveform. */
export function MirrorBars({
  bars,
  className,
  barClassName = "bg-on-inst",
  animate,
}: {
  bars: readonly number[];
  className?: string;
  barClassName?: string;
  animate?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-[3px]", className)} aria-hidden="true">
      {bars.map((height, index) => (
        <span
          key={index}
          className={cn("min-w-0 flex-1 rounded-full", barClassName, animate && "jam-bar-in")}
          style={{ height: `${Math.max(6, Math.round(height * 100))}%`, "--jam-b": Math.min(index, 48) } as CSSProperties}
        />
      ))}
    </div>
  );
}

/**
 * One dot per instrument on the song, in its colour with its icon, and a dashed
 * dot for each one the song is still asking for. On a cover the filled dots sit
 * on a dark capsule so they read on any gradient.
 */
export function BandStrip({
  instruments,
  missing = [],
  size = "md",
  className,
}: {
  instruments: readonly JamInstrument[];
  missing?: readonly JamInstrument[];
  size?: "sm" | "md";
  className?: string;
}) {
  const { t } = useTranslation();
  const dot = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  const icon = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full bg-on-inst p-1", className)}
      role="img"
      aria-label={[
        ...bandOrder(instruments).map((one) => t(JAM_INSTRUMENT_LOOK[one].nameKey as MessageKey)),
        ...missing.map((one) => t(JAM_INSTRUMENT_LOOK[one].missingKey as MessageKey)),
      ].join(", ")}
    >
      {bandOrder(instruments).map((one) => {
        const look = JAM_INSTRUMENT_LOOK[one];
        const Icon = look.icon;
        return (
          <span key={one} className={cn("grid shrink-0 place-items-center rounded-full", dot, look.fill)}>
            <Icon className={icon} aria-hidden="true" />
          </span>
        );
      })}
      {missing.map((one) => {
        const look = JAM_INSTRUMENT_LOOK[one];
        const Icon = look.icon;
        return (
          <span
            key={`missing-${one}`}
            className={cn("grid shrink-0 place-items-center rounded-full border border-dashed", dot, look.ink, "border-current")}
          >
            <Icon className={icon} aria-hidden="true" />
          </span>
        );
      })}
    </span>
  );
}

/** Overlapping faces of the people on a song, with "+N" past the ones shown. */
export function ContributorStack({
  people,
  total,
  size = "md",
  ringClassName = "ring-on-inst",
  className,
}: {
  people: readonly JamContributor[];
  total: number;
  size?: "sm" | "md" | "lg";
  ringClassName?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const face = size === "lg" ? "h-9 w-9" : size === "sm" ? "h-6 w-6" : "h-7 w-7";
  const shown = people.slice(0, 4);
  const more = Math.max(0, total - shown.length);
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className={cn("flex items-center", className)} aria-hidden="true">
      {shown.map((person, index) => (
        <span
          key={person.id}
          className={cn("relative rounded-full ring-2", ringClassName, index > 0 && "-ml-2")}
          style={{ zIndex: shown.length - index }}
        >
          <UserAvatar name={person.name ?? t("jam.tile.anonymous")} avatarUrl={person.avatarUrl} rounded="full" className={face} />
        </span>
      ))}
      {more > 0 && (
        <span
          className={cn(
            "-ml-2 grid place-items-center rounded-full bg-on-inst text-[11px] font-bold tabular-nums text-on-media ring-2",
            ringClassName,
            face,
          )}
        >
          +{more}
        </span>
      )}
    </span>
  );
}

/**
 * What a song is asking for. A song asking for somebody is the one call on its
 * tile: a filled chip in the missing instrument's colour, "+ Falta voz". A song
 * open to anybody, or ready, only says so: a quiet line, never something that
 * looks like a button. `compact` is the small tile's version: "+ Voz".
 */
export function NeedChip({
  need,
  className,
  tone = "cover",
  compact = false,
}: {
  need: JamNeed;
  className?: string;
  /** On a cover (over the dark scrim) or on a panel surface. */
  tone?: "cover" | "panel" | "line";
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = useNeedLabel()(need);
  if (need.kind === "missing") {
    const first = need.instruments[0]!;
    const look = JAM_INSTRUMENT_LOOK[first];
    const more = need.instruments.length - 1;
    const words = compact
      ? more > 0
        ? t("jam.needs.missingCount", { count: more + 1, countLabel: more + 1 })
        : t(look.missingKey as MessageKey)
      : label;
    // On a tile the missing part already shows as a dashed band: the words say it
    // in that instrument's colour, without one more filled button.
    if (tone === "line") {
      return (
        <span
          data-jam-need="missing"
          className={cn("inline-flex w-fit max-w-full items-center gap-1 text-[13px] font-bold", look.ink, className)}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={3} aria-hidden="true" />
          <span className="truncate first-letter:uppercase">{words}</span>
        </span>
      );
    }
    return (
      <span
        data-jam-need="missing"
        className={cn("inline-flex h-7 w-fit max-w-full items-center gap-1 rounded-full pl-2 pr-2.5 text-xs font-bold", look.fill, className)}
      >
        <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={3} aria-hidden="true" />
        <span className="truncate first-letter:uppercase">{words}</span>
      </span>
    );
  }
  const Icon = need.kind === "open" ? Users : need.kind === "ready" ? Check : null;
  return (
    <span
      data-jam-need={need.kind}
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-1.5 text-[13px] font-semibold",
        tone === "cover" ? "text-on-media-muted" : "text-text-secondary",
        className,
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />}
      <span className="truncate first-letter:uppercase">{label}</span>
    </span>
  );
}

/** Three bars dancing: something is playing. Still under reduced motion. */
export function Equalizer({ className, barClassName = "bg-current" }: { className?: string; barClassName?: string }) {
  return (
    <span className={cn("inline-flex h-3.5 items-end gap-[2px]", className)} aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn("jam-eq w-[3px] rounded-full", barClassName)}
          style={{ "--jam-eq": index } as CSSProperties}
        />
      ))}
    </span>
  );
}

/** A label above a section of a panel, in the jam's voice. */
export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", className)}>
      <h3 className="font-display text-base font-extrabold text-text">{children}</h3>
      {aside}
    </div>
  );
}
