import { Check } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The composer's own few controls. A story is a photograph's world: its
 * surfaces are dark in every theme (see the STORIES block in `index.css`), so
 * the themed primitives in `components/ui/` cannot sit on them, a dark label
 * on the light theme's paper would be unreadable on the dark tray. These take
 * the `--story-*` tokens instead and nothing else.
 */

type StoryButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet";
  size?: "md" | "sm";
};

export const StoryButton = forwardRef<HTMLButtonElement, StoryButtonProps>(function StoryButton(
  { variant = "primary", size = "md", className, style, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex flex-none items-center justify-center gap-1.5 rounded-full font-bold transition-[transform,filter,background] duration-[var(--duration-fast)] hover:brightness-105 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none motion-reduce:active:scale-100",
        size === "md" ? "h-11 px-5 text-sm" : "h-9 px-4 text-[13px]",
        className,
      )}
      style={
        variant === "primary"
          ? { background: "var(--story-accent)", color: "var(--story-on-accent)", ...style }
          : { background: "var(--story-field-fill)", color: "var(--story-on-media)", ...style }
      }
      {...props}
    />
  );
});

export function StoryCheckRow({
  checked,
  disabled,
  label,
  description,
  onCheckedChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  description?: string;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-[12px] px-2.5 py-2.5 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-60" : "hover:bg-[var(--story-field-fill)]",
      )}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold" style={{ color: "var(--story-on-media)" }}>
          {label}
        </span>
        {description && (
          <span className="block truncate text-xs" style={{ color: "var(--story-on-media-2)" }}>
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] border transition-colors"
        style={{
          background: checked ? "var(--story-accent)" : "transparent",
          borderColor: checked ? "var(--story-accent)" : "var(--story-field-edge)",
          color: "var(--story-on-accent)",
        }}
      >
        {checked && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
    </button>
  );
}

export function StorySwitch({
  checked,
  onCheckedChange,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-[12px] px-0.5 py-1.5 text-left"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold" style={{ color: "var(--story-on-media)" }}>
          {label}
        </span>
        {description && (
          <span className="block text-xs" style={{ color: "var(--story-on-media-2)" }}>
            {description}
          </span>
        )}
      </span>
      <span
        aria-hidden
        className="relative h-6 w-10 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "var(--story-accent)" : "var(--story-track)" }}
      >
        <span
          className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full shadow-sm transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none"
          style={{
            background: checked ? "var(--story-on-accent)" : "var(--story-on-media)",
            transform: checked ? "translateX(16px)" : "none",
          }}
        />
      </span>
    </button>
  );
}

export interface ModeOption<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
}

/**
 * The mode row under the shutter (Camera, Text, Call). A radio group in the
 * ARIA sense, one stop in the tab order, arrows move the choice.
 */
export function ModeTabs<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ModeOption<T>[];
  onChange: (next: T) => void;
}) {
  const enabled = options.filter((option) => !option.disabled);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[(index + step + enabled.length) % enabled.length];
    if (next) {
      onChange(next.value);
      requestAnimationFrame(() => {
        event.currentTarget.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
      });
    }
  }
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="mx-auto flex items-center gap-1 rounded-full p-1"
      style={{ background: "var(--story-dim)" }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            data-story-mode={option.value}
            onClick={() => onChange(option.value)}
            className="flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-bold transition-colors duration-[var(--duration-fast)] disabled:opacity-40 motion-reduce:transition-none"
            style={{
              background: selected ? "var(--story-on-media)" : "transparent",
              color: selected ? "var(--story-card)" : "var(--story-on-media-2)",
            }}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
