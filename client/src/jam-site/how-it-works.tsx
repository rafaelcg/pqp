import { jt } from "@/lib/i18n/jam-site";
import { MicIcon as Mic, MusicIcon as Music, PlayIcon as Play, type IconComponent } from "./icons";
import { INSTRUMENT_LOOK, type Instrument } from "./instruments";
import { cn } from "./util";

/**
 * "Como funciona": three short steps under the home's hero, so somebody who has
 * never heard of a jam knows what one is before they press play. Static: the
 * icons are the site's own, the colours are the instruments' role tokens, and
 * it fetches nothing.
 */

const STEPS: ReadonlyArray<{
  id: "listen" | "record" | "mix";
  icon: IconComponent;
  /** Only picks a hue from the instrument palette; the step is not about an instrument. */
  hue: Instrument;
}> = [
  { id: "listen", icon: Play, hue: "bass" },
  { id: "record", icon: Mic, hue: "vocals" },
  { id: "mix", icon: Music, hue: "keys" },
];

export function HowItWorks({ className }: { className?: string }) {
  return (
    <section aria-labelledby="jam-how-title" data-jam-how="" className={cn("mt-8 sm:mt-10", className)}>
      <h2 id="jam-how-title" className="text-sm font-semibold text-text-secondary">
        {jt("intro.title")}
      </h2>
      <ol className="mt-3 grid gap-2 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-3 sm:grid-cols-3 sm:gap-4 sm:p-4">
        {STEPS.map((step, index) => {
          const Icon = step.icon;
          return (
            <li key={step.id} data-jam-how-step={step.id} className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full", INSTRUMENT_LOOK[step.hue].fill)}
              >
                <Icon className="h-[18px] w-[18px]" fill={step.id === "listen" ? "currentColor" : "none"} />
              </span>
              <p className="min-w-0 text-[15px] font-semibold leading-5">
                <span aria-hidden="true" className="mr-1.5 font-display font-extrabold text-text-secondary">
                  {index + 1}
                </span>
                {jt(`intro.${step.id}` as Parameters<typeof jt>[0])}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
