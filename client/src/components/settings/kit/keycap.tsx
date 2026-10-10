import { cn } from "@/lib/utils";

/**
 * The names a combo's modifiers go by, in every spelling a caller might hand
 * over. `formatBinding` in `voice/push-to-talk.ts` writes Ctrl, Alt, Shift and
 * Cmd; the symbols are what an Apple keyboard prints.
 */
const MODIFIERS = new Set([
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
  "cmd",
  "command",
  "meta",
  "win",
  "super",
  "⌘",
  "⌥",
  "⇧",
  "⌃",
]);

export function isModifierKeyLabel(label: string): boolean {
  return MODIFIERS.has(label.trim().toLowerCase());
}

/**
 * One key. 24px tall with a 12px glyph, because on Atalhos the keys are the
 * content and have to be the most visible thing on the row. A modifier is
 * quieter than the key it modifies, so the letter is what the eye lands on.
 *
 * `onSurface2` raises the cap one step when the field behind it is surface-2,
 * where the default cap would disappear.
 */
export function SettingsKeycap({
  children,
  modifier,
  onSurface2 = false,
  className,
}: {
  children: string;
  /** Defaults to whether the label names a modifier. */
  modifier?: boolean;
  onSurface2?: boolean;
  className?: string;
}) {
  const isModifier = modifier ?? isModifierKeyLabel(children);
  return (
    <kbd
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-[var(--radius-control)] border border-border-strong px-1.5 font-mono text-xs",
        onSurface2 ? "bg-surface-3" : "bg-surface-2",
        isModifier ? "text-text-secondary" : "text-text",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * A whole combo in one field: the caps sit together on a surface-0 well,
 * without a box each. `KeyBindingField` draws its value through this, and it is
 * the only place keys are drawn.
 *
 * `keys` is one label per key, modifiers first (`["Ctrl", "Shift", "K"]`);
 * `formatBinding(...).split(" + ")` produces exactly that. `label` names the
 * whole combo for a screen reader, which would otherwise read the caps as
 * separate words.
 */
export function SettingsKeyCombo({
  keys,
  label,
  className,
}: {
  keys: readonly string[];
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-control)] bg-surface-0 p-1",
        className,
      )}
    >
      {keys.map((key, index) => (
        <SettingsKeycap key={`${key}-${index}`}>{key}</SettingsKeycap>
      ))}
    </span>
  );
}
