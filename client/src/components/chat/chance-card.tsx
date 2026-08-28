import type { ChanceResult } from "@pqp/shared";
import { rollGroups } from "@pqp/shared";
import { Coins, Dices, RefreshCw, Shuffle, Spade, type LucideIcon } from "lucide-react";
import { CommandChip } from "@/components/chat/command-chip";
import coinHeadsUrl from "@/assets/chance/coin-heads.svg?url";
import coinTailsUrl from "@/assets/chance/coin-tails.svg?url";
import { d6FaceUrl, playingCardUrl, polyhedralDieUrl } from "@/lib/chance-art";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COMMAND_META: Record<ChanceResult["type"], { icon: LucideIcon; key: MessageKey }> = {
  roll: { icon: Dices, key: "chance.command.roll" },
  flip: { icon: Coins, key: "chance.command.flip" },
  choose: { icon: Shuffle, key: "chance.command.choose" },
  draw: { icon: Spade, key: "chance.command.draw" },
  shuffle: { icon: RefreshCw, key: "chance.command.shuffle" },
};

/*
 * The shared shell for a chance object: a soft tonal surface with a whisper
 * of signal, lit from above (inset highlight) and resting on a soft shadow.
 * Depth comes from lighting, never from a 1px border. Black/white here are
 * light and shade, not palette — same category as --scrim-media.
 */
const SHELL = cn(
  "mt-1.5 max-w-md rounded-2xl px-4 py-3",
  "bg-[linear-gradient(165deg,color-mix(in_oklab,var(--color-signal)_6%,var(--color-surface-2)),var(--color-surface-2)_72%)]",
  "shadow-[inset_0_1px_0_rgb(255_255_255/0.05),0_1px_2px_rgb(0_0_0/0.1),0_12px_28px_-20px_rgb(0_0_0/0.55)]",
);

export function ChanceCard({ result }: { result: ChanceResult }) {
  const { t } = useTranslation();
  const meta = COMMAND_META[result.type];
  return (
    <div data-chance={result.type} className={SHELL}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <CommandChip icon={meta.icon} label={t(meta.key)} />
        {result.type === "roll" && (
          <span className="font-mono text-[11px] text-paper-muted">{result.notation}</span>
        )}
        {result.type === "roll" && result.comment && (
          <span className="text-[13px] text-paper">{result.comment}</span>
        )}
      </div>

      {result.type === "roll" && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ul className="flex flex-wrap items-center gap-2">
            {rollGroups(result).flatMap((group, groupIndex) =>
              group.faces.map((face, faceIndex) => (
                <DieFace
                  key={`${groupIndex}-${faceIndex}-${face}`}
                  value={face}
                  sides={group.sides}
                />
              )),
            )}
            {result.modifier !== 0 && (
              <li className="font-mono text-sm text-paper-muted">
                {result.modifier > 0 ? `+${result.modifier}` : result.modifier}
              </li>
            )}
          </ul>
          <p
            className={cn(
              "flex items-center gap-2 font-display text-4xl font-bold leading-none tabular-nums",
              result.notation.includes("d20") && result.total === 20 && result.faces.length === 1 && result.modifier === 0
                ? "text-signal"
                : result.notation.includes("d20") && result.total === 1 && result.faces.length === 1 && result.modifier === 0
                  ? "text-danger"
                  : "text-paper",
            )}
          >
            {(result.faces.length > 1 || result.modifier !== 0) && (
              <span aria-hidden className="text-xl font-normal text-paper-muted">
                =
              </span>
            )}
            <span className="sr-only">{t("chance.total")} </span>
            {result.total}
          </p>
        </div>
      )}

      {result.type === "flip" && (
        <div className="mt-3 flex items-center gap-4">
          <Coin side={result.result} />
          <p className="font-display text-2xl font-bold leading-none text-paper">
            {t(result.result === "heads" ? "chance.flip.heads" : "chance.flip.tails")}
          </p>
          <p className="sr-only">
            {t("chance.flip.result", {
              side: t(result.result === "heads" ? "chance.flip.heads" : "chance.flip.tails"),
            })}
          </p>
        </div>
      )}

      {result.type === "choose" && (
        <div className="mt-2.5">
          <p className="text-xs text-paper-muted">{t("chance.choose.picked")}</p>
          <p className="mt-0.5 font-display text-2xl font-bold leading-tight text-paper">
            {result.picked}
          </p>
          <span aria-hidden className="mt-1.5 block h-1 w-8 rounded-full bg-signal/70" />
          {result.options.length > 2 && (
            <ul className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-paper-muted">
              {result.options
                .filter((option) => option !== result.picked)
                .map((option, index) => (
                  <li key={`${index}-${option}`} className="flex items-center gap-x-1.5">
                    {index > 0 && (
                      <span aria-hidden className="text-paper-muted/50">
                        ·
                      </span>
                    )}
                    {option}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {result.type === "draw" && (
        <div className="mt-3">
          <ul
            className={
              result.cards.length <= DRAW_FAN_MAX
                ? "flex items-end pb-2 pt-3"
                : "flex flex-wrap gap-1.5"
            }
          >
            {result.cards.map((card, index) => (
              <PlayingCardFace
                key={`${index}-${card}`}
                code={card}
                index={index}
                count={result.cards.length}
              />
            ))}
          </ul>
          {result.remaining !== undefined && (
            <p className="mt-1 text-[11px] text-paper-muted">
              {result.reshuffled
                ? t("chance.draw.reshuffled", { count: result.remaining })
                : t("chance.draw.remaining", { count: result.remaining })}
            </p>
          )}
        </div>
      )}

      {result.type === "shuffle" && (
        <p className="mt-2.5 font-display text-xl font-bold text-paper">
          {t("chance.shuffle.done", { count: result.remaining })}
        </p>
      )}
    </div>
  );
}

function DieFace({ value, sides }: { value: number; sides: number }) {
  const crit = sides === 20 && (value === 20 || value === 1);
  const glow =
    sides === 20 && value === 20
      ? "drop-shadow-[0_0_10px_color-mix(in_oklab,var(--color-signal)_70%,transparent)]"
      : sides === 20 && value === 1
        ? "drop-shadow-[0_0_10px_color-mix(in_oklab,var(--color-danger)_70%,transparent)]"
        : "drop-shadow-[0_4px_8px_rgb(0_0_0/0.4)]";
  const pipUrl = sides === 6 ? d6FaceUrl(value) : undefined;
  if (pipUrl) {
    return (
      <li aria-label={String(value)} className="h-14 w-14 shrink-0">
        <img src={pipUrl} alt="" className={cn("h-14 w-14", glow)} />
      </li>
    );
  }

  const bodyUrl = polyhedralDieUrl(sides);
  if (bodyUrl) {
    return (
      <li
        aria-label={String(value)}
        className={cn("relative h-16 w-14 shrink-0", glow)}
      >
        <img src={bodyUrl} alt="" className="h-full w-full" />
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 flex items-center justify-center font-display text-xl font-extrabold tabular-nums [text-shadow:0_0_6px_#fff,0_0_2px_#fff,0_1px_0_#fff]",
            crit && value === 20 && "text-[#14532d]",
            crit && value === 1 && "text-[#7f1d1d]",
            !crit && "text-[#111114]",
          )}
        >
          {value}
        </span>
      </li>
    );
  }

  return (
    <li
      aria-label={String(value)}
      className="flex h-12 w-12 shrink-0 items-center justify-center font-display text-lg font-bold tabular-nums text-paper"
    >
      {value}
    </li>
  );
}

function Coin({ side }: { side: "heads" | "tails" }) {
  return (
    <span aria-hidden className="relative h-16 w-16 shrink-0">
      <img
        src={side === "heads" ? coinHeadsUrl : coinTailsUrl}
        alt=""
        className="h-16 w-16 drop-shadow-[0_5px_10px_rgb(0_0_0/0.45)]"
      />
    </span>
  );
}

/** A held-hand fan. Past this, a wrap keeps every index readable. */
const DRAW_FAN_MAX = 5;

function PlayingCardFace({
  code,
  index,
  count,
}: {
  code: string;
  index: number;
  count: number;
}) {
  const art = playingCardUrl(code);
  const fan = count >= 2 && count <= DRAW_FAN_MAX;
  const spread = index - (count - 1) / 2;
  return (
    <li
      aria-label={code}
      style={
        fan
          ? {
              transform: `rotate(${spread * 4}deg) translateY(${Math.abs(spread) * 2}px)`,
              zIndex: index,
            }
          : undefined
      }
      className={cn(
        "relative h-[4.75rem] w-[3.25rem] shrink-0 origin-bottom drop-shadow-[0_3px_8px_rgb(0_0_0/0.45)]",
        fan && index > 0 && "-ml-3.5",
      )}
    >
      {art ? (
        <img src={art} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-lg bg-paper font-display text-xs text-ink">
          {code}
        </span>
      )}
    </li>
  );
}
