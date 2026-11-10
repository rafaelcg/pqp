import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import type { CSSProperties } from "react";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { seededBars } from "@/lib/jam-wall";
import { cn } from "@/lib/utils";
import { JamBars } from "./jam-bars";
import type { JamInstrument } from "@pqp/shared";

/**
 * How a jam works, as a picture before words: three lanes slide in one after
 * the other and sit on top of each other, each a different person's part,
 * each in its instrument's colour. The same picture is the hero of the first-run
 * card and the head of the "Como funciona" sheet.
 */

const LANES: readonly { instrument: JamInstrument; seed: string }[] = [
  { instrument: "guitar", seed: "howto-guitar" },
  { instrument: "bass", seed: "howto-bass" },
  { instrument: "vocals", seed: "howto-vocals" },
];

export function JamHowToHero({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex flex-col justify-center gap-2 bg-surface-0 px-4 py-5", className)}
    >
      {LANES.map((lane, index) => {
        const look = JAM_INSTRUMENT_LOOK[lane.instrument];
        const Icon = look.icon;
        return (
          <div
            key={lane.instrument}
            style={{ "--jam-l": index } as CSSProperties}
            className="jam-howto-lane flex items-center gap-2"
          >
            <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full", look.fill)}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className={cn("h-8 min-w-0 flex-1 rounded-[var(--radius-control)] px-2 py-1.5", look.fill)}>
              <JamBars bars={seededBars(lane.seed, 56)} className="h-full" barClassName="bg-on-inst" animate />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function JamHowToDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const steps = [
    { title: t("jam.howto.one.title"), body: t("jam.howto.one.body") },
    { title: t("jam.howto.two.title"), body: t("jam.howto.two.body") },
    { title: t("jam.howto.three.title"), body: t("jam.howto.three.body") },
  ];
  return (
    <Dialog
      open={open}
      title={t("jam.howto.title")}
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end">
          <Button onClick={onClose} data-jam-howto-close="">
            {t("jam.howto.gotIt")}
          </Button>
        </div>
      }
    >
      <DialogBody>
      <JamHowToHero className="mb-4 rounded-[var(--radius-card)]" />
      <ol className="flex flex-col gap-4">
        {steps.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-extrabold tabular-nums text-on-accent-soft"
            >
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-sm font-bold text-text">{step.title}</h3>
              <p className="text-sm leading-relaxed text-text-secondary [text-wrap:pretty]">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      </DialogBody>
    </Dialog>
  );
}
