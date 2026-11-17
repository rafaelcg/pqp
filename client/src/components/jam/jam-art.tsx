import type { JamInstrument, JamContributor } from "@pqp/shared";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { cn } from "@/lib/utils";

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

/**
 * The Jam's glyph: three lanes of a song, each in an instrument's colour, drawn
 * like a lucide icon (24 grid, round 2.5 strokes) so it sits in a menu row's icon
 * slot with the same size and weight as its siblings' "#" and still says "Jam".
 */
function JamLanesGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={3} strokeLinecap="round" aria-hidden="true" className={className}>
      <path d="M4 6h11" className="stroke-inst-guitar" />
      <path d="M4 12h16" className="stroke-inst-bass" />
      <path d="M4 18h8" className="stroke-inst-vocals" />
    </svg>
  );
}
export const JamGlyph = JamLanesGlyph as unknown as LucideIcon;

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
  size?: "xs" | "sm" | "md" | "lg";
  ringClassName?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const face = size === "lg" ? "h-9 w-9" : size === "sm" ? "h-6 w-6" : size === "xs" ? "h-5 w-5" : "h-7 w-7";
  const shown = people.slice(0, size === "xs" ? 3 : 4);
  const more = Math.max(0, total - shown.length);
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className={cn("flex items-center", className)} aria-hidden="true">
      {shown.map((person, index) => (
        <span
          key={person.id}
          className={cn("relative rounded-full ring-2", ringClassName, index > 0 && "-ml-1.5")}
          style={{ zIndex: shown.length - index }}
        >
          <UserAvatar name={person.name ?? t("jam.tile.anonymous")} avatarUrl={person.avatarUrl} rounded="full" className={face} />
        </span>
      ))}
      {more > 0 && size !== "xs" && (
        <span
          className={cn(
            "-ml-1.5 grid min-w-[1.5rem] place-items-center rounded-full bg-surface-3 px-1 text-[11px] font-bold tabular-nums text-text ring-2",
            ringClassName,
            face,
            "w-auto",
          )}
        >
          +{more}
        </span>
      )}
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
