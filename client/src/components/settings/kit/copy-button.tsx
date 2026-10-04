import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * How long the check (and "Copiado") stays after a copy. One number for every
 * copy affordance in Settings: the rail's build line, Ajuda's address and
 * version, Perfil's link and tag.
 */
export const SETTINGS_COPIED_MS = 1500;

/**
 * Copies `text` and says so for `SETTINGS_COPIED_MS`. Every successful copy
 * restarts the clock, so a second click while the check shows keeps it up.
 *
 * No clipboard (plain http, an old webview): `copy` does nothing, `copied`
 * never turns on, and whatever shows the text stays selectable.
 */
export function useCopyText(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => {
        if (!mounted.current) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        setCopied(true);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (mounted.current) setCopied(false);
        }, SETTINGS_COPIED_MS);
      })
      .catch(() => undefined);
  }, [text]);

  return { copied, copy };
}

export interface SettingsCopyButtonProps {
  /** What goes on the clipboard. */
  text: string;
  /**
   * The action ("Copiar endereço"): the tooltip and, through it, the button's
   * accessible name, so the two can never say different things.
   */
  label: string;
  /**
   * Announced, and shown with `showLabel`, after a copy. Defaults to
   * "Copiado"; pass "Link copiado" where the object is worth naming.
   */
  copiedLabel?: string;
  /**
   * `false` (default): an icon-only ghost button with a `Tooltip`, which needs
   * the app's `TooltipProvider` above it. `true`: a secondary `sm` button
   * with the icon and the label as text ("Copiar link"), no tooltip.
   */
  showLabel?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * The one copy button in Settings. The icon turns into a check for
 * `SETTINGS_COPIED_MS` and an always-mounted live region says `copiedLabel`:
 * a live region that appears together with its text is often not read.
 */
export function SettingsCopyButton({
  text,
  label,
  copiedLabel: copiedLabelProp,
  showLabel = false,
  disabled,
  className,
}: SettingsCopyButtonProps) {
  const { t } = useTranslation();
  const copiedLabel = copiedLabelProp ?? t("settings.rail.copied");
  const { copied, copy } = useCopyText(text);
  const icon = copied ? (
    <Check aria-hidden className="h-3.5 w-3.5 shrink-0 animate-icon-swap text-success" />
  ) : (
    <Copy aria-hidden className="h-3.5 w-3.5 shrink-0" />
  );
  const announcement = (
    <span role="status" className="sr-only">
      {copied ? copiedLabel : ""}
    </span>
  );

  if (showLabel) {
    return (
      <>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={copy}
          className={className}
          // A steady name while the visible text swaps to "Copiado": the swap
          // is announced by the live region below, not by renaming the button.
          aria-label={label}
        >
          {icon}
          <span aria-hidden={copied || undefined}>{copied ? copiedLabel : label}</span>
        </Button>
        {announcement}
      </>
    );
  }

  return (
    <>
      <Tooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={copy}
          className={cn("w-[var(--control-sm)] shrink-0 px-0", className)}
        >
          {icon}
        </Button>
      </Tooltip>
      {announcement}
    </>
  );
}
