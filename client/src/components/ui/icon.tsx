import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An icon in the redesign's set (docs/redesign/LOG.md): Phosphor, filled.
 *
 * ONE RULE PICKS THE WEIGHT, so a surface never chooses it per icon:
 *
 * | Kind     | Weight | What it draws                                     |
 * |----------|--------|---------------------------------------------------|
 * | `object` | fill   | A thing: a speaker, a bell, a gear, a person      |
 * | `symbol` | bold   | A mark: `#`, `+`, `@`, a caret, a cross, a search |
 *
 * A filled `#` or `+` is a solid box, which is why symbols take the bold
 * outline instead. The size is a token (`--icon-sm` 16, `--icon-md` 20,
 * `--icon-lg` 24), written as a class so it beats Phosphor's own width and
 * height attributes.
 *
 * Decorative by default: an icon next to a word is read by the word. Pass
 * `label` when the icon is the only thing that says what a control does.
 */
export type IconKind = "object" | "symbol";
export type IconSize = "sm" | "md" | "lg";

const SIZE: Record<IconSize, string> = {
  sm: "h-[var(--icon-sm)] w-[var(--icon-sm)]",
  md: "h-[var(--icon-md)] w-[var(--icon-md)]",
  lg: "h-[var(--icon-lg)] w-[var(--icon-lg)]",
};

export interface IconProps {
  icon: PhosphorIcon;
  kind?: IconKind;
  size?: IconSize;
  label?: string;
  className?: string;
}

export function Icon({
  icon: Glyph,
  kind = "object",
  size = "md",
  label,
  className,
}: IconProps) {
  return (
    <Glyph
      weight={kind === "object" ? "fill" : "bold"}
      className={cn("shrink-0", SIZE[size], className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

/**
 * A surface that is not rebuilt everywhere yet: the Lucide icon it always
 * drew with the toggle off, the Phosphor one under the redesign. Decorative.
 *
 * `offClassName` is the old icon's own classes (its size, colour, margin);
 * `className` goes on the new one, beside the size token.
 */
export function IconSwap({
  off: Off,
  on,
  kind = "object",
  size = "sm",
  offClassName,
  className,
}: {
  off: LucideIcon;
  on: PhosphorIcon;
  kind?: IconKind;
  size?: IconSize;
  offClassName?: string;
  className?: string;
}) {
  return (
    <>
      <Off aria-hidden className={cn(offClassName, "redesign:hidden")} />
      <Icon icon={on} kind={kind} size={size} className={cn("hidden redesign:block", className)} />
    </>
  );
}
