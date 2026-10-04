import type { ReactNode } from "react";

interface SettingsPreviewProps {
  /** A sentence a screen reader gets in place of the drawing. */
  summary?: string;
  /**
   * The drawing. Hidden from assistive tech while `decorative`; `summary`
   * speaks for it.
   */
  children: ReactNode;
  /** Rows that drive the drawing, under a divider. */
  controls?: ReactNode;
  /**
   * `true` (default): the whole drawing is `aria-hidden`. `false`: the drawing
   * holds a control a person operates in place (Voz's sensitivity handle on
   * the live meter), so it stays in the accessibility tree. The caller then
   * marks the purely visual parts `aria-hidden` itself and names the control,
   * for example `Slider aria-label` with `aria-valuetext`.
   */
  decorative?: boolean;
}

/**
 * Show, don't tell: a live drawing of what a setting changes, with the controls
 * that change it underneath. The Aparência chat preview is the model.
 */
export function SettingsPreview({
  summary,
  children,
  controls,
  decorative = true,
}: SettingsPreviewProps) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-border">
      {summary ? <p className="sr-only">{summary}</p> : null}
      <div aria-hidden={decorative || undefined} className="bg-surface-0">
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
