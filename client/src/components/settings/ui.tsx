import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A labelled group inside a section. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wide text-paper-muted">
        {label}
      </p>
      {children}
      {hint && <p className="mt-1.5 text-xs text-paper-muted">{hint}</p>}
    </div>
  );
}

const CHIP_BASE =
  "rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60";

export function chipClass(selected: boolean): string {
  return cn(
    CHIP_BASE,
    selected
      ? "border-accent bg-accent/10 text-text"
      : "border-border text-text-muted hover:border-accent/50",
  );
}

/* -------------------------------------------------------------- appearance */

export function SettingBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium text-text">{label}</h4>
        {hint ? (
          <p className="mt-0.5 min-h-[2.5rem] text-xs text-text-muted">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function segmentClass(selected: boolean, disabled = false): string {
  return cn(
    "flex h-9 items-center justify-center rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
    selected
      ? "bg-surface-0 text-text shadow-sm"
      : "text-text-muted hover:text-text",
    disabled && "cursor-not-allowed opacity-40 hover:text-text-muted",
  );
}

export function SwitchRow({
  label,
  hint,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className={cn("flex items-start gap-2 text-sm text-paper", disabled && "opacity-50")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span>
        {label}
        <span className="block text-xs text-paper-muted">{hint}</span>
      </span>
    </label>
  );
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
