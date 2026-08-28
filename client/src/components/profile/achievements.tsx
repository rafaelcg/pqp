import { useId } from "react";
import {
  CACA_BUGS_BADGE,
  TURMA_1000_BADGE,
  type ProfileAchievement,
} from "@pqp/shared";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Earned marks: the Turma dos 1000 medal and the caça-bugs pin.
 *
 * NOT CHIPS, and not community tiles either. A community tile is a room
 * somebody chose; these are things somebody WAS, so they render as physical
 * objects — a struck coin with the founding number engraved on its face, and
 * a quieter pin in the same family beside it. The number is the artifact
 * (one of a thousand, never recycled), which is why it lives on the object
 * rather than in a label.
 *
 * Hides itself when empty so a profile with none looks like it did before
 * this existed. `variant="compact"` is the same object scaled for the profile
 * card, not a different metaphor: a small coin beside one line of type, so
 * the marks read as facts about the person rather than a second identity
 * block competing with the name. The sublines are the full page's job.
 */

/** The medal outranks the pin regardless of the order the server sent. */
const DISPLAY_ORDER: Record<string, number> = {
  [TURMA_1000_BADGE]: 0,
  [CACA_BUGS_BADGE]: 1,
};

/**
 * The full name of the mark, for AT and anywhere else that needs it as one
 * string. The number engraved on the medal is a decorative duplicate of this.
 */
export function achievementLabel(
  achievement: ProfileAchievement,
  t: Translator["t"],
): string {
  if (achievement.badge === TURMA_1000_BADGE && achievement.ordinal != null) {
    return t("publicProfile.achievements.turma1000.label", {
      n: achievement.ordinal,
    });
  }
  return achievement.name;
}

function achievementSubline(
  achievement: ProfileAchievement,
  t: Translator["t"],
): string | undefined {
  if (achievement.badge === CACA_BUGS_BADGE) {
    return t("publicProfile.achievements.cacaBugs");
  }
  if (achievement.badge === TURMA_1000_BADGE) {
    return t("publicProfile.achievements.turma1000");
  }
  return undefined;
}

/** Reeded-edge angles shared by the medal and the pin — one family. */
const REEDS = Array.from({ length: 56 }, (_, i) => (i / 56) * Math.PI * 2);

function reedLines(inner: number, outer: number, every = 1) {
  return REEDS.filter((_, i) => i % every === 0).map((angle) => ({
    x1: 40 + Math.cos(angle) * inner,
    y1: 40 + Math.sin(angle) * inner,
    x2: 40 + Math.cos(angle) * outer,
    y2: 40 + Math.sin(angle) * outer,
  }));
}

/**
 * The founding medal. Deliberately metal in both themes — every colour here
 * is a `--medal-*` token, a physical-object palette like the connection
 * marks: a coin that followed the accent would stop being a coin.
 * The number is HTML over the SVG so Gabarito renders it, not a path.
 *
 * One strike, one gold, for all thousand — the turma is a class, not a
 * leaderboard, and the ordinal on the face already says everything a finish
 * tier tried to say. (A dark-nickel 1–10 shipped once and read as the
 * disabled state on this surface.)
 *
 * Digits only on the face — `#` is the discriminator and a hashtag in this
 * product, and coins put digits on the metal. The small `Nº` keeps the
 * plaque read on the full size, and yields at four digits rather than
 * squeezing the number into mush.
 *
 * Compact drops the inner groove and the light text-shadow: at card size
 * those two read as noise around a 10px digit, which is why 7 was hard
 * to see next to the name.
 */
function FoundersMedal({ ordinal, size }: { ordinal: number; size: number }) {
  const id = useId();
  const compact = size < 56;
  const digits = String(ordinal);
  const digitScale =
    digits.length >= 4 ? (compact ? 0.34 : 0.28) : compact ? 0.46 : 0.34;
  return (
    <span
      aria-hidden
      className="relative block shrink-0 rounded-full shadow-[var(--shadow-medal)]"
      style={
        {
          width: size,
          height: size,
          "--m-hi": "var(--medal-gold-hi)",
          "--m-mid": "var(--medal-gold)",
          "--m-deep": "var(--medal-gold-deep)",
          "--m-engrave": "var(--medal-gold-engrave)",
          "--m-relief": "var(--medal-gold-relief)",
        } as React.CSSProperties
      }
    >
      <svg viewBox="0 0 80 80" className="block h-full w-full">
        <defs>
          <radialGradient id={`${id}-face`} cx="35%" cy="28%" r="85%">
            <stop offset="0%" style={{ stopColor: "var(--m-hi)" }} />
            <stop offset="55%" style={{ stopColor: "var(--m-mid)" }} />
            <stop offset="100%" style={{ stopColor: "var(--m-deep)" }} />
          </radialGradient>
        </defs>
        <circle cx="40" cy="40" r="39.5" fill={`url(#${id}-face)`} />
        {/* Compact: a brighter inner field so the digit is not sitting on
            the gradient's dark stop. Full size has the room to read without
            it. */}
        {compact && (
          <circle
            cx="40"
            cy="36"
            r="22"
            fill="var(--m-hi)"
            opacity="0.45"
          />
        )}
        <g stroke="var(--m-engrave)" strokeWidth="1" opacity="0.3">
          {reedLines(35, 38.5).map((line, i) => (
            <line key={i} {...line} />
          ))}
        </g>
        <circle
          cx="40"
          cy="40"
          r="39"
          fill="none"
          stroke="var(--m-engrave)"
          strokeWidth="1"
          opacity="0.45"
        />
        {/* The groove between rim and face: a cut with the light its lower
            edge catches, which is what reads as engraving. */}
        <circle
          cx="40"
          cy="40"
          r="33"
          fill="none"
          stroke="var(--m-engrave)"
          strokeWidth="0.9"
          opacity="0.35"
        />
        <circle
          cx="40"
          cy="40"
          r="32.1"
          fill="none"
          stroke="var(--m-relief)"
          strokeWidth="0.7"
          opacity="0.55"
        />
        {/* A second, finer groove. Full size only: on the card it ate the
            face the number needs. */}
        {!compact && (
          <>
            <circle
              cx="40"
              cy="40"
              r="28"
              fill="none"
              stroke="var(--m-engrave)"
              strokeWidth="0.7"
              opacity="0.3"
            />
            <circle
              cx="40"
              cy="40"
              r="27.2"
              fill="none"
              stroke="var(--m-relief)"
              strokeWidth="0.55"
              opacity="0.45"
            />
          </>
        )}
      </svg>
      <span
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center font-display font-extrabold tabular-nums leading-none text-[color:var(--m-engrave)]",
          !compact && "[text-shadow:0_1px_0_var(--m-relief)]",
        )}
      >
        {!compact && digits.length <= 3 && (
          <span style={{ fontSize: size * 0.125 }} className="opacity-75">
            Nº
          </span>
        )}
        <span
          style={{
            fontSize: size * digitScale,
            marginTop: compact ? 0 : size * 0.015,
          }}
        >
          {digits}
        </span>
      </span>
    </span>
  );
}

/**
 * The quieter sibling: same reeded disc, no gold, no number. Themed with the
 * role tokens so light mode keeps it a pin rather than a smudge. The glyph is
 * ours, not a lucide icon — the family is hand-struck.
 */
function SealPin({
  size,
  glyph,
}: {
  size: number;
  glyph: "bug" | "spark";
}) {
  return (
    <span
      aria-hidden
      className="relative block shrink-0 text-paper-muted"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 80 80" className="block h-full w-full">
        <circle cx="40" cy="40" r="39" fill="var(--color-surface-2)" />
        <g stroke="currentColor" strokeWidth="1" opacity="0.28">
          {reedLines(35, 38.5, 2).map((line, i) => (
            <line key={i} {...line} />
          ))}
        </g>
        <circle
          cx="40"
          cy="40"
          r="38.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.45"
        />
        <circle
          cx="40"
          cy="40"
          r="32.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="0.75"
          opacity="0.2"
        />
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          className="text-paper"
        >
          {glyph === "bug" ? (
            <>
              <circle cx="40" cy="27" r="5.5" />
              <path d="M36.5 22.5 32 17M43.5 22.5 48 17" />
              <ellipse cx="40" cy="46" rx="10.5" ry="12.5" />
              <path d="M40 34v24" opacity="0.45" />
              <path d="M29.5 41h-8.5M29.5 48.5H21M32 54.5 25.5 61" />
              <path d="M50.5 41H59M50.5 48.5H59M48 54.5 54.5 61" />
            </>
          ) : (
            <path d="M40 26v28M26 40h28M31 31l18 18M49 31 31 49" />
          )}
        </g>
      </svg>
    </span>
  );
}

export function Achievements({
  achievements,
  className,
  variant = "full",
}: {
  achievements: ProfileAchievement[];
  className?: string;
  variant?: "full" | "compact";
}) {
  const { t } = useTranslation();
  if (achievements.length === 0) {
    return null;
  }
  const full = variant === "full";
  const ordered = [...achievements].sort(
    (a, b) => (DISPLAY_ORDER[a.badge] ?? 9) - (DISPLAY_ORDER[b.badge] ?? 9),
  );
  return (
    <ul
      className={cn(
        full
          ? "flex flex-wrap items-center gap-x-10 gap-y-5"
          : "flex flex-col gap-2",
        className,
      )}
      aria-label={t("publicProfile.achievements")}
    >
      {ordered.map((achievement) => {
        const isMedal =
          achievement.badge === TURMA_1000_BADGE && achievement.ordinal != null;
        const subline = achievementSubline(achievement, t);
        return (
          <li
            key={achievement.badge}
            className={cn(
              "flex min-w-0 items-center",
              full ? "gap-4" : "gap-2.5",
            )}
            // Compact drops the visible subline; the hover keeps the story.
            title={full ? undefined : subline}
          >
            {isMedal ? (
              <FoundersMedal
                ordinal={achievement.ordinal as number}
                size={full ? 72 : 40}
              />
            ) : (
              <SealPin
                size={full ? 48 : 26}
                glyph={achievement.badge === CACA_BUGS_BADGE ? "bug" : "spark"}
              />
            )}
            <span className="min-w-0 text-left">
              {/* One clean sentence for AT — the engraved number above is a
                  decorative duplicate of this. */}
              <span className="sr-only">{achievementLabel(achievement, t)}</span>
              <span
                aria-hidden
                className={cn(
                  "block truncate text-paper",
                  full && isMedal
                    ? "font-display text-lg font-bold leading-tight"
                    : full
                      ? "text-sm font-semibold leading-tight"
                      : "text-[13px] font-medium leading-tight",
                )}
              >
                {achievement.name}
              </span>
              {full && subline && (
                <span className="mt-0.5 block text-[13px] text-paper-muted">
                  {subline}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
