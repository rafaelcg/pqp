import * as SliderPrimitive from "@radix-ui/react-slider";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const root = cva(
  "group relative flex w-full touch-none select-none items-center data-[disabled]:opacity-40",
  {
    variants: {
      variant: {
        scrub: "h-4",
        volume: "h-4",
        /** Compact player: the fill sits on the panel's bottom border. */
        edge: "h-3 items-end",
        /** A colour wheel: the track is the gradient, there is no fill. */
        hue: "h-5",
      },
    },
    defaultVariants: {
      variant: "scrub",
    },
  },
);

const track = cva("relative w-full grow overflow-hidden", {
  variants: {
    variant: {
      scrub: "h-0.5 rounded-full bg-surface-3",
      volume: "h-1 rounded-full bg-surface-3",
      edge: "h-0.5 bg-border",
      hue: "h-2 rounded-full bg-[image:var(--accent-track)]",
    },
  },
  defaultVariants: {
    variant: "scrub",
  },
});

const thumb = cva(
  "block shrink-0 rounded-full border border-border-strong bg-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring",
  {
    variants: {
      variant: {
        scrub:
          "h-3 w-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        volume: "h-3 w-3",
        edge:
          "h-3 w-3 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        hue: "h-4 w-4 border-2 border-on-accent bg-accent",
      },
    },
    defaultVariants: {
      variant: "scrub",
    },
  },
);

export interface SliderProps
  extends Omit<
      ComponentPropsWithoutRef<typeof SliderPrimitive.Root>,
      "value" | "defaultValue" | "onValueChange" | "onValueCommit"
    >,
    VariantProps<typeof root> {
  value: number;
  onValueChange?: (value: number) => void;
  onValueCommit?: (value: number) => void;
  /**
   * Progress only: the fill follows `value`, and the thumb is not drawn.
   * Managers use the interactive `scrub` variant to seek.
   */
  readOnly?: boolean;
  /** Track only, no fill. Used while duration is still unknown. */
  indeterminate?: boolean;
}

/**
 * One-dimensional value. `scrub` is a thin track whose thumb appears on
 * hover or focus. `volume` keeps the thumb visible. `edge` is the same
 * fill sitting on a panel's bottom border. `hue` is a colour wheel: the
 * `--accent-track` gradient as the track, no fill, and a thumb in the current
 * accent with an `on-accent` rim. `readOnly` draws the fill without a thumb and
 * does not seek.
 */
export function Slider({
  className,
  variant = "scrub",
  value,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  readOnly = false,
  indeterminate = false,
  onValueChange,
  onValueCommit,
  "aria-label": ariaLabel,
  "aria-valuetext": ariaValueText,
  ...props
}: SliderProps) {
  const span = max - min;
  const clamped = Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : min;
  const fill = span <= 0 ? 0 : ((clamped - min) / span) * 100;

  if (readOnly) {
    return (
      <div
        role="progressbar"
        aria-valuemin={min}
        aria-valuemax={indeterminate ? undefined : max}
        aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
        aria-valuetext={indeterminate ? undefined : ariaValueText}
        aria-label={ariaLabel}
        data-slider={variant}
        data-readonly=""
        data-indeterminate={indeterminate ? "" : undefined}
        className={cn(root({ variant }), className)}
        {...(props as HTMLAttributes<HTMLDivElement>)}
      >
        <div className={track({ variant })}>
          {!indeterminate && (
            <div
              className="absolute h-full bg-accent"
              style={{ width: `${fill}%` }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <SliderPrimitive.Root
      value={[clamped]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      data-slider={variant}
      onValueChange={(next) => {
        onValueChange?.(next[0] ?? min);
      }}
      onValueCommit={(next) => {
        onValueCommit?.(next[0] ?? min);
      }}
      className={cn(root({ variant }), className)}
      {...props}
    >
      <SliderPrimitive.Track className={track({ variant })}>
        {/* A hue has no "amount", so nothing fills up to the thumb: the
            gradient is the whole track and the thumb wears the colour. */}
        {variant === "hue" ? null : (
          <SliderPrimitive.Range className="absolute h-full bg-accent" />
        )}
      </SliderPrimitive.Track>
      {/* The name goes on the thumb: it is the element with `role="slider"`,
          and Radix leaves a single thumb unnamed otherwise. */}
      <SliderPrimitive.Thumb
        className={cn(thumb({ variant }))}
        aria-label={ariaLabel}
        aria-valuetext={ariaValueText}
      />
    </SliderPrimitive.Root>
  );
}
