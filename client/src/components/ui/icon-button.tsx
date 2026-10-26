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
 * redesign, the selected fill. Only with a fixed `label`: a control whose
 * label or icon swaps (expand and collapse) is an action, not a toggle, or a
 * screen reader hears "Collapse, pressed".
 *
 * THE REDESIGN changes it through `--icon-button-*` tokens that are unset
 * with the toggle off and fall back, in the class, to what the forum's icon
 * buttons drew, so a call site's own class still wins (`docs/DESIGN.md`, "The
 * redesign"). The pressed state is the one `redesign:` class, because nothing
 * paints a pressed icon button from outside.
 */
export type IconButtonSize = "xs" | "sm" | "md" | "lg";

/*
 * The box and the glyph inside it. The primitive owns the glyph's size, so
 * the ratio is the same on every screen; a caller's own `h-4` on the icon
 * loses to it. With the toggle off, `md` is the 16px the forum drew and `lg`
 * the 20px of the phone menu it replaced.
 */
const SIZE: Record<IconButtonSize, string> = {
  xs: "h-6 w-6 [&_svg]:size-[var(--icon-button-glyph-xs,0.875rem)]",
  sm: "h-7 w-7 [&_svg]:size-[var(--icon-button-glyph-sm,1rem)]",
  md: "h-8 w-8 [&_svg]:size-[var(--icon-button-glyph-md,1rem)]",
  lg: "h-9 w-9 [&_svg]:size-[var(--icon-button-glyph-lg,1.25rem)]",
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
    disabled,
    onClick,
    onPointerDown,
    onKeyDown,
    children,
    ...props
  },
  ref,
) {
  // DISABLED keeps the button hoverable and focusable, so its tooltip can
  // still name it (a native `disabled` kills both). It is `aria-disabled`
  // and its handlers, a trigger's included, are not wired.
  return (
    <Tooltip label={label} detail={detail} side={side}>
      <button
        ref={ref}
        type={type}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : onClick}
        onPointerDown={disabled ? undefined : onPointerDown}
        onKeyDown={disabled ? undefined : onKeyDown}
        className={cn(
          "grid shrink-0 place-items-center rounded-[var(--icon-button-radius,var(--radius-control))] text-[color:var(--icon-button-text,var(--color-text-tertiary))] transition-[background,color,transform] duration-[var(--duration-fast)] hover:bg-[var(--icon-button-hover,var(--color-surface-2))] hover:text-text active:scale-[var(--icon-button-press,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-[length:var(--icon-button-ring-offset,0px)] focus-visible:ring-offset-ring-offset",
          SIZE[size],
          touch && "max-sm:h-11 max-sm:w-11",
          tone === "danger" &&
            "hover:bg-[var(--icon-button-danger-hover,var(--color-surface-2))] hover:text-danger",
          // A toggle that is on: the selected fill and the accent glyph, a
          // step deeper on hover. The one place this primitive uses
          // `redesign:` classes, since nothing paints it from outside.
          "redesign:aria-pressed:bg-row-selected redesign:aria-pressed:text-accent-text redesign:aria-pressed:hover:bg-[color:color-mix(in_oklab,var(--color-row-selected)_88%,var(--color-text))] redesign:aria-pressed:hover:text-accent-text",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-[var(--button-disabled-opacity,0.4)] aria-disabled:hover:bg-transparent aria-disabled:hover:text-[color:var(--icon-button-text,var(--color-text-tertiary))] aria-disabled:active:scale-100",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
