import { Check, CircleX, Copy } from "lucide-react";
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
 * The pre-Clipboard-API copy: select a hidden textarea and ask the browser to
 * copy the selection. Still the only way that works on plain http and in some
 * webviews. The textarea goes inside the open dialog when there is one, so a
 * focus trap does not pull focus back out before the copy runs.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const previous = document.activeElement as HTMLElement | null;
  const host = previous?.closest?.('[role="dialog"]') ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  host.append(area);
  let ok = false;
  try {
    area.select();
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus?.({ preventScroll: true });
  return ok;
}

/** The Clipboard API first, then the legacy path. True when either copied. */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or no user activation: try the old way before giving up.
    }
  }
  return legacyCopy(text);
}

/**
 * Selects the text inside `element`, so a copy that failed leaves the person
 * one Cmd/Ctrl+C away from what they wanted.
 */
function selectContents(element: HTMLElement | null | undefined) {
  if (!element || typeof window.getSelection !== "function") return;
  const selection = window.getSelection();
  if (!selection) return;
  try {
    selection.selectAllChildren(element);
  } catch {
    // Nothing selectable there; the message still says what to do.
  }
}

/**
 * Copies `text` and says so for `SETTINGS_COPIED_MS`. Every successful copy
 * restarts the clock, so a second click while the check shows keeps it up.
 *
 * When nothing can copy (plain http with the old path refused too, a denied
 * permission), `failed` turns on and stays until the next attempt, and
 * `selectOnFail` (the element that shows the text) is selected for the person.
 * The caller says "Não deu pra copiar, seleciona o texto" next to it: a click
 * that silently does nothing reads as broken.
 */
export function useCopyText(
  text: string,
  { selectOnFail }: { selectOnFail?: () => HTMLElement | null } = {},
): { copied: boolean; failed: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);
  const selectRef = useRef(selectOnFail);
  selectRef.current = selectOnFail;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(() => {
    setFailed(false);
    void writeClipboardText(text).then((ok) => {
      if (!mounted.current) return;
      if (!ok) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
        setCopied(false);
        setFailed(true);
        selectContents(selectRef.current?.());
        return;
      }
      if (timer.current !== null) window.clearTimeout(timer.current);
      setCopied(true);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        if (mounted.current) setCopied(false);
      }, SETTINGS_COPIED_MS);
    });
  }, [text]);

  return { copied, failed, copy };
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
  /**
   * The accessible name when it must say more than the tooltip: the tooltip
   * reads "Copiar versão pra mandar no suporte", the name carries the build.
   */
  name?: string;
  /** Selected for the person when the copy fails. */
  selectOnFail?: () => HTMLElement | null;
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
  name,
  selectOnFail,
  disabled,
  className,
}: SettingsCopyButtonProps) {
  const { t } = useTranslation();
  const copiedLabel = copiedLabelProp ?? t("settings.rail.copied");
  const { copied, failed, copy } = useCopyText(text, { selectOnFail });
  const icon = copied ? (
    <Check aria-hidden className="h-3.5 w-3.5 shrink-0 animate-icon-swap text-success" />
  ) : failed ? (
    <CircleX aria-hidden className="h-3.5 w-3.5 shrink-0 animate-icon-swap text-danger" />
  ) : (
    <Copy aria-hidden className="h-3.5 w-3.5 shrink-0" />
  );
  const announcement = (
    <span role="status" className="sr-only">
      {copied ? copiedLabel : failed ? t("settings.status.copyFailed") : ""}
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
          aria-label={name ?? label}
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
      <Tooltip label={label} name={name}>
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
