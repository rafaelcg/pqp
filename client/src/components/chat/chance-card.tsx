import type { ChanceResult } from "@pqp/shared";
import { Check, Coins, Dices, Shuffle, Spade, type LucideIcon } from "lucide-react";
import { CommandChip } from "@/components/chat/command-chip";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const COMMAND_META: Record<ChanceResult["type"], { icon: LucideIcon; key: MessageKey }> = {
  roll: { icon: Dices, key: "chance.command.roll" },
  flip: { icon: Coins, key: "chance.command.flip" },
  choose: { icon: Shuffle, key: "chance.command.choose" },
  draw: { icon: Spade, key: "chance.command.draw" },
};

export function ChanceCard({ result }: { result: ChanceResult }) {
  const { t } = useTranslation();
  const meta = COMMAND_META[result.type];
  return (
    <div
      data-chance={result.type}
      className="mt-1.5 max-w-md rounded-lg border border-border bg-surface-2/60 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <CommandChip icon={meta.icon} label={t(meta.key)} />
        {result.type === "roll" && (
          <span className="font-mono text-xs text-paper-muted">{result.notation}</span>
        )}
      </div>
      {result.type === "roll" && (
        <div className="mt-2.5">
          <ul className="flex flex-wrap items-center gap-1.5">
            {result.faces.map((face, index) => (
              <li
                key={`${index}-${face}`}
                className="flex h-9 min-w-9 items-center justify-center rounded-lg border border-ink-4 bg-ink-3 px-1.5 font-mono text-sm font-semibold tabular-nums text-paper"
              >
                {face}
              </li>
            ))}
            {result.modifier !== 0 && (
              <li className="px-0.5 font-mono text-sm text-paper-muted">
                {result.modifier > 0 ? `+${result.modifier}` : result.modifier}
              </li>
            )}
          </ul>
          <p className="mt-2.5 flex items-baseline gap-2 border-t border-border/60 pt-2">
            <span className="text-[11px] uppercase tracking-wide text-paper-muted">
              {t("chance.total")}
            </span>
            <span className="text-3xl font-bold leading-none tabular-nums text-signal">
              {result.total}
            </span>
          </p>
        </div>
      )}
      {result.type === "flip" && (
        <>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            {(["heads", "tails"] as const).map((side) => {
              const won = result.result === side;
              return (
                <span
                  key={side}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-md border px-2 py-2.5 text-sm font-semibold",
                    won
                      ? "border-signal/60 bg-signal/15 text-paper"
                      : "border-ink-4 text-paper-muted opacity-60",
                  )}
                >
                  {won && <Check className="h-4 w-4 shrink-0 text-signal" aria-hidden />}
                  {t(side === "heads" ? "chance.flip.heads" : "chance.flip.tails")}
                </span>
              );
            })}
          </div>
          <p className="sr-only">
            {t("chance.flip.result", {
              side: t(result.result === "heads" ? "chance.flip.heads" : "chance.flip.tails"),
            })}
          </p>
        </>
      )}
      {result.type === "choose" && (
        <ul className="mt-2.5 space-y-1">
          {result.options.map((option, index) => {
            const picked = option === result.picked;
            return (
              <li
                key={`${index}-${option}`}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                  picked
                    ? "border-signal/60 bg-signal/10 font-medium text-paper"
                    : "border-transparent text-paper-muted",
                )}
              >
                {picked ? (
                  <Check className="h-4 w-4 shrink-0 text-signal" aria-hidden />
                ) : (
                  <span className="w-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 break-words">{option}</span>
                {picked && (
                  <span className="ml-auto shrink-0 text-[11px] font-medium uppercase tracking-wide text-signal">
                    {t("chance.choose.picked")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {result.type === "draw" && (
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {result.cards.map((card, index) => (
            <PlayingCardFace key={`${index}-${card}`} code={card} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PlayingCardFace({ code }: { code: string }) {
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  const red = suit === "H" || suit === "D";
  const pip = { S: "♠", H: "♥", D: "♦", C: "♣" }[suit] ?? suit;
  return (
    <li
      aria-label={code}
      className={cn(
        "relative h-16 w-11 shrink-0 rounded-md bg-paper shadow-md ring-1 ring-ink-4",
        red ? "text-danger" : "text-ink",
      )}
    >
      <span
        aria-hidden
        className="absolute left-1 top-1 font-mono text-[10px] font-bold leading-none"
      >
        {rank}
      </span>
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center text-lg leading-none"
      >
        {pip}
      </span>
      <span
        aria-hidden
        className="absolute bottom-1 right-1 rotate-180 font-mono text-[10px] font-bold leading-none"
      >
        {rank}
      </span>
    </li>
  );
}
