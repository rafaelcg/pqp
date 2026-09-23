import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Where you are in the first run, on the left of the footer buttons.
 *
 * Shared by the age gate and the wizard so the two read as one flow: the gate
 * is screen one, and the wizard picks up at two rather than restarting the
 * count at one after somebody has already answered a screen.
 *
 * Not clickable: the screens are answered in order. The active dot stretches
 * into a pill (width is the one non-transform property animated here; three
 * 6px dots are not worth a layout trick), finished ones stay lit at half
 * strength, the rest sit on the border colour.
 */
export function StepDots({ index, total }: { index: number; total: number }) {
  const { t } = useTranslation();
  if (total < 2) {
    return <span className="mr-auto" />;
  }
  return (
    <span
      role="img"
      aria-label={t("onboarding.progress", { index: index + 1, total })}
      data-onboarding-progress={index + 1}
      data-onboarding-total={total}
      className="mr-auto flex items-center gap-1.5 self-center"
    >
      {Array.from({ length: total }, (_, dot) => (
        <span
          key={dot}
          aria-hidden="true"
          className={cn(
            "h-1.5 rounded-full transition-[width,background-color] duration-[var(--duration-slow)] ease-[var(--ease-emphasized)]",
            dot === index
              ? "w-5 bg-accent"
              : dot < index
                ? "w-1.5 bg-accent/50"
                : "w-1.5 bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}
