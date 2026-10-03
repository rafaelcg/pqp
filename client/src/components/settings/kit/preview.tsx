import type { ReactNode } from "react";

interface SettingsPreviewProps {
  /** A sentence a screen reader gets in place of the drawing. */
  summary?: string;
  /** The drawing. Hidden from assistive tech; `summary` speaks for it. */
  children: ReactNode;
  /** Rows that drive the drawing, under a divider. */
  controls?: ReactNode;
}

/**
 * Show, don't tell: a live drawing of what a setting changes, with the controls
 * that change it underneath. The Aparência chat preview is the model.
 */
export function SettingsPreview({
  summary,
  children,
  controls,
}: SettingsPreviewProps) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-border">
      {summary ? <p className="sr-only">{summary}</p> : null}
      <div aria-hidden className="bg-surface-0">
        {children}
      </div>
      {controls ? (
        <div className="divide-y divide-border border-t border-border bg-surface-card">
          {controls}
        </div>
      ) : null}
    </div>
  );
}
