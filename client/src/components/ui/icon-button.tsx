import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Tooltip, type TooltipProps } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A control that is only an icon: pin, settings, close, mute, more.
 *
 * WHY A PRIMITIVE. The app drew about 180 of these by hand as raw `<button>`s,
 * plus four named copies (`PostIconButton`, `ChromeButton`,
 * `HEADER_ACTION_TILE`, `CHANNEL_ACTION_TILE`), with six heights, three hover
 * fills and, in about a third of them, no accessible name at all. Here the
 * name is required: `label` becomes the tooltip and the `aria-label` (through
 * `Tooltip`), so the two cannot say different things.
 *
 * | Size | Box  | Where                                      |
 * |------|------|--------------------------------------------|
 * | `xs` | 24px | inside a row, beside text                  |
 * | `sm` | 28px | a row's trailing actions                   |
 * | `md` | 32px | a header or a toolbar (default)            |
 * | `lg` | 36px | beside a default `Button`                  |
 *
 * `touch` (on by default) grows the box to 44px under 640px, the phone's tap
 * target. `tone="danger"` turns the icon red on hover, for remove and leave.
 * `pressed` is a toggle (mute, pin): it sets `aria-pressed` and, under the
 * redesign, the selected fill.
 *
 * THE REDESIGN changes it through `--icon-button-*` tokens that are unset
 * with the toggle off and fall back, in the class, to what the forum's icon
 * buttons drew, so a call site's own class still wins (`docs/DESIGN.md`, "The
 * redesign"). The pressed state is the one `redesign:` class, because nothing
 * paints a pressed icon button from outside.
 */
export type IconButtonSize = "xs" | "sm" | "md" | "lg";

const SIZE: Record<IconButtonSize, string> = {
  xs: "h-6 w-6",
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-9 w-9",
};

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "aria-pressed"> {
  /** What the control does, in a few words. The tooltip and the accessible name. */
  label: string;
  /** A second, quieter line in the tooltip. */
  detail?: string;
  size?: IconButtonSize;
  tone?: "ghost" | "danger";
  /** A toggle's state. Leave undefined for a plain action. */
  pressed?: boolean;
  /** 44px under 640px. On by default. */
  touch?: boolean;
  /** Where the tooltip opens. */
  side?: TooltipProps["side"];
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    detail,
    size = "md",
    tone = "ghost",
    pressed,
    touch = true,
    side,
    className,
    type = "button",
    children,
    ...props
  },
  ref,
) {
  return (
    <Tooltip label={label} detail={detail} side={side}>
      <button
        ref={ref}
        type={type}
        aria-pressed={pressed}
        className={cn(
          "grid shrink-0 place-items-center rounded-[var(--icon-button-radius,var(--radius-control))] text-[color:var(--icon-button-text,var(--color-text-tertiary))] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--icon-button-hover,var(--color-surface-2))] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-[var(--button-disabled-opacity,0.4)]",
          SIZE[size],
          touch && "max-sm:h-11 max-sm:w-11",
          tone === "danger" &&
            "hover:bg-[var(--icon-button-danger-hover,var(--color-surface-2))] hover:text-danger",
          "redesign:aria-pressed:bg-row-selected redesign:aria-pressed:text-on-row-selected",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
