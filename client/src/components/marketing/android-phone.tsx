import { cn } from "@/lib/utils";

/**
 * A real screenshot of the Android app, in a phone drawn in CSS.
 *
 * WHY A DRAWN FRAME AND NOT A MOCKUP IMAGE. `/download`'s `AppWindow` draws a
 * window because there is no desktop screenshot to show; here the opposite is
 * true — the screenshot is real (`docs/review/play-listing/04-chamada.png`,
 * the same capture that goes to the Play listing) and only the phone around it
 * is invented. Drawing that phone keeps the one honest pixel honest: nothing in
 * the frame claims a device we do not ship on, it costs no bytes, and it takes
 * the page's own accent instead of some vendor's press-kit render.
 *
 * The frame deliberately draws NO status bar and NO gesture pill. The capture
 * came off a real device and already has both; adding ours would double them.
 *
 * WHY THERE IS A SECOND SIZE rather than one frame scaled with a width class.
 * Border radius does not scale with the box. The hero's 36px corners on a
 * 64px-wide card thumbnail make a pill, not a phone, and the same is true of
 * the bezel padding and the camera dot. So the two places this appears — the
 * `/android` hero and the in-app prompt — pick a variant instead of a scale
 * factor, and stay recognisably the same object.
 */
export function AndroidPhone({
  alt,
  className,
  variant = "full",
  loading = "lazy",
}: {
  /** Translated by the caller — this component holds no copy. */
  alt: string;
  /** Sets the width. The aspect ratio comes from the image itself. */
  className?: string;
  /** `full` for a hero, `compact` for a thumbnail around 4rem wide. */
  variant?: "full" | "compact";
  loading?: "lazy" | "eager";
}) {
  const compact = variant === "compact";

  return (
    <div className={cn("relative", className)}>
      {/* The glow sits behind the phone and outside it, so the bezel keeps a
          hard edge against the page instead of dissolving into the gradient.
          A thumbnail sitting on a card needs no spotlight. */}
      {!compact && (
        <div
          aria-hidden
          className="absolute -inset-8 rounded-full bg-signal/10 blur-3xl"
        />
      )}

      <div className="relative">
        {/* Power and volume, on the right edge like every Android phone. Purely
            decorative, and hidden from the tree: a screen reader announcing
            "button" here would be announcing a drawing. Too small to read at
            thumbnail size, so they are not drawn there. */}
        {!compact && (
          <>
            <span
              aria-hidden
              className="absolute -right-[3px] top-[18%] h-[7%] w-[3px] rounded-r-sm bg-ink-4"
            />
            <span
              aria-hidden
              className="absolute -right-[3px] top-[28%] h-[12%] w-[3px] rounded-r-sm bg-ink-4"
            />
          </>
        )}

        <div
          className={cn(
            "relative overflow-hidden border border-ink-4/80 bg-ink-2 ring-1 ring-white/5",
            compact
              ? "rounded-[0.7rem] p-[2px]"
              : "rounded-[2.25rem] p-[6px] shadow-2xl shadow-black/60",
          )}
        >
          <div
            className={cn(
              "relative overflow-hidden bg-black",
              compact ? "rounded-[0.55rem]" : "rounded-[1.9rem]",
            )}
          >
            <img
              src="/images/beta-android.webp"
              alt={alt}
              width={720}
              height={1280}
              loading={loading}
              className="block w-full"
            />
            {/* The punch-hole camera, over the screen rather than in the bezel,
                which is where Android phones actually put it. */}
            {!compact && (
              <span
                aria-hidden
                className="absolute left-1/2 top-[10px] h-2 w-2 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
