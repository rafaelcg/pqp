import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium transition-[background,color,transform] duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-accent hover:bg-accent-hover font-semibold",
        secondary:
          "bg-surface-2 text-text hover:bg-border border border-border",
        ghost: "hover:bg-surface-2 text-text-tertiary hover:text-text",
        danger:
          "bg-danger-soft text-on-danger-soft hover:bg-danger-soft-hover",
      },
      size: {
        default: "h-[var(--control-md)] px-4 py-2",
        sm: "h-[var(--control-sm)] rounded-[var(--radius-control)] px-3 text-xs",
        icon: "h-[var(--control-md)] w-[var(--control-md)]",
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

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
