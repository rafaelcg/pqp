import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * THE REDESIGN (docs/redesign/LOG.md) changes a button through component
 * tokens, never through `redesign:` classes. A `redesign:` class outranks the
 * call site's own class, so a ghost button a caller paints red would turn
 * grey under the toggle; a token used as `px-[var(--button-px,1rem)]` loses to
 * the caller's `px-6` through `cn`, exactly as the plain class did.
 *
 * Every token is UNSET with the toggle off and falls back, in the class
 * itself, to the value the button always drew, so nothing changes. The
 * redesign sets them on `:root[data-redesign]` in `index.css`: a pill, more
 * horizontal room, a lifted primary, and fills that are tints of the text, so
 * they read on a pane and on a dialog alike.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-button)] text-sm font-medium transition-[background,color,transform] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-[var(--button-disabled-opacity,0.4)] active:scale-[0.98]",
  {
    variants: {
      variant: {
        // Disabled under the redesign is a switched-off button, not a dim
        // lime one: an empty pill in the strong edge with a muted label at
        // full strength. It keeps its outline on a dialog, and with no fill
        // it cannot pass for a live secondary button beside it. Those are `redesign:` classes
        // on purpose: they only touch the disabled state, and a disabled
        // primary should look off whatever colour its caller gave it.
        default:
          "bg-accent text-on-accent hover:bg-accent-hover font-semibold shadow-[var(--button-primary-shadow,0_0_transparent)] redesign:disabled:border redesign:disabled:border-border-strong redesign:disabled:bg-transparent redesign:disabled:text-text-tertiary redesign:disabled:[--button-primary-shadow:0_0_transparent] redesign:disabled:[--button-disabled-opacity:1]",
        // The redesign's fill and hover are tints of the text, so the button
        // keeps its edge on any surface, a dialog included.
        secondary:
          "bg-[color:var(--button-secondary-bg,var(--color-surface-2))] text-text hover:bg-[color:var(--button-secondary-hover,var(--color-border))] border border-[color:var(--button-secondary-border,var(--color-border))]",
        ghost:
          "hover:bg-[var(--button-ghost-hover,var(--color-surface-2))] text-[color:var(--button-ghost-text,var(--color-text-tertiary))] hover:text-text",
        danger:
          "bg-danger-soft text-on-danger-soft hover:bg-danger-soft-hover",
        // A destructive action that should not shout: "Deixar de seguir",
        // "Remover". Ghost until hover, red text throughout. With the toggle
        // off its hover is the ghost one, as the call sites it replaced drew
        // it; the redesign keeps it red, on the soft danger fill.
        "danger-ghost":
          "hover:bg-[var(--button-danger-ghost-hover,var(--color-surface-2))] text-danger hover:text-[color:var(--button-danger-ghost-hover-text,var(--color-text))]",
      },
      size: {
        default: "h-[var(--control-md)] px-[var(--button-px,1rem)] py-2",
        sm: "h-[var(--control-sm)] px-[var(--button-px-sm,0.75rem)] text-[length:var(--button-text-sm,0.75rem)] leading-4",
        // The touch-size action (44px): a full-width confirm, a phone sheet,
        // an onboarding step. Replaces a hand-written `h-11` on a default
        // button and draws exactly what that drew with the toggle off.
        lg: "h-11 px-[var(--button-px-lg,1rem)] py-2",
        icon: "h-[var(--control-md)] w-[var(--control-md)]",
        // The icon square on the rest of the ladder. An icon-only control
        // on its own is `IconButton`; these match a row of text buttons.
        "icon-sm": "h-[var(--control-sm)] w-[var(--control-sm)]",
        "icon-lg": "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * `forwardRef`, so a caller can move focus to the button it just revealed
 * ("Enviar outro" after a feedback send) without a wrapper and a
 * `querySelector`.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, asChild = false, ...props }, ref) {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
