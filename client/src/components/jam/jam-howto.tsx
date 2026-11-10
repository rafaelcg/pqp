import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { Headphones, Mic, Plus, Send } from "lucide-react";
import type { CSSProperties } from "react";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { seededBars } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { JamBars } from "./jam-bars";
import type { JamInstrument } from "@pqp/shared";

/**
 * How a jam works, as a picture before words: a little band of lanes on one
 * timeline. The parts slide in one after the other, each a different person in
 * their instrument's colour; a playhead sweeps across all of them at once (it
 * is one song); the last lane is dashed and says "tu". The same picture heads
 * the empty wall, the first-run card and the "Como funciona" sheet.
 */

const LANES: readonly { instrument: JamInstrument; seed: string; from: number; to: number }[] = [
  { instrument: "guitar", seed: "howto-guitar", from: 0, to: 100 },
  { instrument: "bass", seed: "howto-bass", from: 8, to: 92 },
  { instrument: "drums", seed: "howto-drums", from: 0, to: 100 },
];

export function JamHowToHero({ className, big = false }: { className?: string; big?: boolean }) {
  const { t } = useTranslation();
  return (
    <div aria-hidden="true" className={cn("relative overflow-hidden bg-surface-0", big ? "px-5 py-6" : "px-4 py-5", className)}>
      <div className={cn("relative flex flex-col", big ? "gap-2.5" : "gap-2")}>
        {LANES.map((lane, index) => {
          const look = JAM_INSTRUMENT_LOOK[lane.instrument];
          const Icon = look.icon;
          return (
            <div key={lane.instrument} style={{ "--jam-l": index } as CSSProperties} className="jam-howto-lane flex items-center gap-2.5">
              <span className={cn("grid shrink-0 place-items-center rounded-full", big ? "h-8 w-8" : "h-7 w-7", look.fill)}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className={cn("relative min-w-0 flex-1 rounded-[var(--radius-control)] bg-surface-2", big ? "h-9" : "h-8")}>
                <div
                  className={cn("absolute inset-y-0 rounded-[var(--radius-control)] px-1.5 py-1.5", look.fill)}
                  style={{ left: `${lane.from}%`, right: `${100 - lane.to}%` }}
                >
                  <JamBars bars={seededBars(lane.seed, big ? 56 : 44)} className="h-full" barClassName="bg-on-inst" />
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ "--jam-l": LANES.length } as CSSProperties} className="jam-howto-lane flex items-center gap-2.5">
          <span
            className={cn(
              "grid shrink-0 place-items-center rounded-full border-2 border-dashed border-accent text-accent",
              big ? "h-8 w-8" : "h-7 w-7",
            )}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={3} />
          </span>
          <div
            className={cn(
              "jam-howto-you flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] border-2 border-dashed border-accent px-3 text-xs font-bold text-accent",
              big ? "h-9" : "h-8",
            )}
          >
            <Mic className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t("jam.howto.you")}</span>
          </div>
        </div>
        {/* one playhead for every lane: it is one song */}
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 [container-type:inline-size]",
            big ? "left-[2.625rem]" : "left-[2.375rem]",
          )}
        >
          <span className="jam-howto-playhead absolute inset-y-[-4px] left-0 w-0.5 rounded-full bg-text shadow-[var(--shadow-2)]" />
        </span>
      </div>
    </div>
  );
}

export function JamHowToDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const steps = [
    { icon: Headphones, title: t("jam.howto.one.title"), body: t("jam.howto.one.body") },
    { icon: Mic, title: t("jam.howto.two.title"), body: t("jam.howto.two.body") },
    { icon: Send, title: t("jam.howto.three.title"), body: t("jam.howto.three.body") },
  ];
  return (
    <Dialog
      open={open}
      title={t("jam.howto.title")}
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end">
          <Button onClick={onClose} data-jam-howto-close="" className="rounded-full px-6">
            {t("jam.howto.gotIt")}
          </Button>
        </div>
      }
    >
      <DialogBody>
        <JamHowToHero className="mb-5 rounded-[var(--radius-card)] ring-1 ring-inset ring-border" />
        <ol className="flex flex-col gap-4">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.title} className="flex gap-3">
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-on-accent-soft">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <h3 className="text-sm font-bold text-text">
                    <span className="mr-1.5 tabular-nums text-text-tertiary">{index + 1}.</span>
                    {step.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-text-secondary [text-wrap:pretty]">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-xs leading-snug text-text-tertiary">
          {t("jam.howto.instruments", {
            list: (["vocals", "guitar", "bass", "drums", "keys"] as const)
              .map((one) => t(JAM_INSTRUMENT_LOOK[one].nameKey as MessageKey))
              .join(", "),
          })}
        </p>
      </DialogBody>
    </Dialog>
  );
}
