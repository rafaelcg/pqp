import { useEffect, useId, useRef, useState } from "react";
import {
  SETTINGS_INSET_FOCUS,
  SETTINGS_TRANSITION,
  SettingsInlineStatus,
  SettingsKeyCombo,
} from "@/components/settings/kit";
import {
  captureBinding,
  captureModifier,
  capturePttKeyboardBinding,
  capturePttModifierBinding,
  captureMouseBinding,
  formatBinding,
  isModifierCode,
  type KeyBinding,
  type PttBinding,
} from "@/components/voice/push-to-talk";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A refusal the field reports instead of drawing, and the id to draw it under. */
export interface KeyBindingRefusal {
  message: string;
  id: string;
}

interface BindingFieldDisplayProps {
  /**
   * Draws `label` for a screen reader only. For a field inside a settings row,
   * where the row already shows the label beside it. Off by default, so a bare
   * field keeps its visible label.
   */
  hideLabel?: boolean;
  /**
   * Hands the refusal (a reserved key, a key in use) to the caller instead of
   * drawing it under the field, so a settings row can show it in its own
   * status slot, under the row's label. The caller draws `message` in an
   * element with `id`, which the field names in `aria-describedby`. Called
   * with `null` when the refusal clears.
   */
  onRefusedChange?: (refusal: KeyBindingRefusal | null) => void;
}

interface KeyBindingFieldProps extends BindingFieldDisplayProps {
  binding: KeyBinding;
  onChange: (binding: KeyBinding) => void;
  label: string;
  /** Label of the row that already owns this chord, if any. */
  takenBy?: (binding: KeyBinding) => string | null;
}

/**
 * "Press a key to bind", not a text field.
 *
 * A text field would ask people to type the *name* of a key, which nobody
 * agrees on ("ctrl" / "control" / "^") and which cannot express the difference
 * between the two Alt keys. Listening for the real event is both easier to use
 * and the only way to record a `code` — see the binding type for why `code` is
 * what gets stored.
 *
 * Capture runs on the window in the capture phase so the keystroke never
 * reaches the app underneath while binding, and every key is `preventDefault`ed
 * for the same reason: binding "S" should not open the browser's save dialog on
 * the way past.
 */
export function KeyBindingField({
  binding,
  onChange,
  label,
  takenBy,
  hideLabel = false,
  onRefusedChange,
}: KeyBindingFieldProps) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // The chord that was refused because another action owns it. The field
  // draws it inside the red border, so the conflict reads as "this key is
  // taken", not as if the current binding were the problem. Never saved.
  const [attempted, setAttempted] = useState<KeyBinding | null>(null);
  const takenByRef = useRef(takenBy);
  const tRef = useRef(t);
  takenByRef.current = takenBy;
  // Same for onChange: a parent that re-renders mid-capture (the Voz level
  // meter does, every frame) hands a new arrow each time, and with it in the
  // effect's deps the listeners were rebuilt between a lone modifier's keydown
  // and keyup, which lost the pending modifier and saved nothing.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  tRef.current = t;

  useEffect(() => {
    if (!capturing) {
      return;
    }

    // A modifier is only a binding if it is released without anything else
    // being pressed — otherwise "Ctrl" would swallow every chord starting with
    // it and "Ctrl + Q" could never be bound.
    let pendingModifier: KeyboardEvent | null = null;

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        setCapturing(false);
        setRefused(null);
        return;
      }

      if (isModifierCode(event.code)) {
        pendingModifier = event;
        return;
      }
      pendingModifier = null;

      const outcome = captureBinding(event);
      if (!outcome.ok) {
        setRefused(tRef.current("keyBinding.refused"));
        return;
      }
      const taken = takenByRef.current?.(outcome.binding);
      if (taken) {
        setRefused(tRef.current("keyBinding.conflict", { action: taken }));
        setAttempted(outcome.binding);
        setCapturing(false);
        return;
      }
      setRefused(null);
      setCapturing(false);
      onChangeRef.current(outcome.binding);
    }

    function onKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!pendingModifier || pendingModifier.code !== event.code) {
        return;
      }
      pendingModifier = null;
      const next = captureModifier(event);
      const taken = takenByRef.current?.(next);
      if (taken) {
        setRefused(tRef.current("keyBinding.conflict", { action: taken }));
        setAttempted(next);
        setCapturing(false);
        return;
      }
      setRefused(null);
      setCapturing(false);
      onChangeRef.current(next);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing]);

  useEffect(() => {
    setRefused(null);
    setAttempted(null);
  }, [binding]);

  return (
    <BindingControl
      label={label}
      binding={attempted ?? binding}
      capturing={capturing}
      prompt={t("keyBinding.press")}
      refused={refused}
      hideLabel={hideLabel}
      onRefusedChange={onRefusedChange}
      onToggle={() => {
        setRefused(null);
        setAttempted(null);
        setCapturing((prev) => !prev);
      }}
      // Leaving the field drops a refused combo: it was never saved, and a
      // red key left on the row reads as if it were.
      onBlur={() => {
        setCapturing(false);
        setRefused(null);
        setAttempted(null);
      }}
    />
  );
}

/**
 * What both fields draw: the binding as keycaps in one well, which is itself
 * the button that arms capture, and the refusal under it.
 *
 * With `hideLabel` the label is for a screen reader only, because the settings
 * row the field sits in shows the visible one beside it. Without it the label
 * sits above the well. With `onRefusedChange` the refusal goes to the caller,
 * which draws it under its row label; without it, it is drawn under the well.
 */
function BindingControl({
  label,
  binding,
  capturing,
  prompt,
  refused,
  hideLabel,
  onRefusedChange,
  onToggle,
  onBlur,
}: {
  label: string;
  binding: KeyBinding;
  capturing: boolean;
  prompt: string;
  refused: string | null;
  hideLabel: boolean;
  onRefusedChange?: (refusal: KeyBindingRefusal | null) => void;
  onToggle: () => void;
  onBlur: () => void;
}) {
  const refusedId = useId();
  const combo = formatBinding(binding);
  const reportRef = useRef(onRefusedChange);
  reportRef.current = onRefusedChange;
  const reports = onRefusedChange !== undefined;

  useEffect(() => {
    reportRef.current?.(refused ? { message: refused, id: refusedId } : null);
  }, [refused, refusedId]);

  useEffect(
    () => () => {
      reportRef.current?.(null);
    },
    [],
  );

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-start gap-1.5",
        hideLabel && "@lg:items-end",
      )}
    >
      {hideLabel ? null : (
        // The button carries the same words for a screen reader, so this
        // visible copy stays out of the accessibility tree. Same caption style
        // as the Voz pane's other field labels, until Voz wraps it in a row.
        <span
          aria-hidden="true"
          className="block text-xs uppercase tracking-wide text-paper-muted"
        >
          {label}
        </span>
      )}
      <button
        type="button"
        // The pressed state is what tells a screen reader the field is armed
        // and swallowing keys, which is otherwise invisible. The shortcut
        // hook also reads it to stand down while a key is being bound.
        data-key-binding-field=""
        aria-pressed={capturing}
        aria-live="polite"
        aria-describedby={refused ? refusedId : undefined}
        onClick={onToggle}
        // Clicking away ends capture rather than leaving the window silently
        // eating every keystroke.
        onBlur={onBlur}
        className={cn(
          "inline-flex min-h-9 max-w-full items-center rounded-[var(--radius-control)] border bg-surface-0 text-left",
          SETTINGS_TRANSITION,
          SETTINGS_INSET_FOCUS,
          capturing
            ? "border-accent ring-2 ring-focus-ring"
            : refused
              ? "border-danger"
              : "border-border hover:border-border-strong",
        )}
      >
        <span className="sr-only">{`${label}: `}</span>
        {capturing ? (
          <span className="px-2.5 py-1.5 text-xs text-pretty text-text-secondary">
            {prompt}
          </span>
        ) : (
          <SettingsKeyCombo keys={combo.split(" + ")} label={combo} />
        )}
      </button>
      {refused && !reports ? (
        <div id={refusedId} className="max-w-80 [&>p]:mt-0">
          <KeyBindingRefusalStatus message={refused} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A refusal as every settings row draws an error: `CircleX`, `text-danger`,
 * `role="alert"`. Exported for a caller that takes it over with
 * `onRefusedChange`.
 */
export function KeyBindingRefusalStatus({ message }: { message: string }) {
  return <SettingsInlineStatus state={{ kind: "error", message }} />;
}

interface PttBindingFieldProps extends BindingFieldDisplayProps {
  binding: PttBinding;
  onChange: (binding: PttBinding) => void;
  label: string;
  /** Label of the row that already owns this chord, if any. */
  takenBy?: (binding: PttBinding) => string | null;
  /**
   * Whether a mousedown may be captured as a binding. Off by default on the
   * WEB build: middle-click and the browser back/forward buttons already do
   * something in a browser tab (open in new tab, navigate history), and a
   * page has no global hook to make a mouse-bound PTT work while unfocused
   * anyway; see `use-push-to-talk.ts`. Electron passes `true`: the shell can
   * both capture the click cleanly (no address bar to navigate) and back the
   * binding with the native hook while the window is elsewhere.
   */
  allowMouse?: boolean;
}

/**
 * `KeyBindingField`'s push-to-talk sibling: same "press something to bind
 * it" shape, widened to accept a mouse button alongside a key. Kept as its
 * own component rather than a prop on `KeyBindingField` because the two
 * capture different event streams (`mousedown` in addition to `keydown`) and
 * produce a different binding shape (`PttBinding`, not `KeyBinding`), see
 * `push-to-talk.ts` for why those are deliberately not the same type.
 */
export function PttBindingField({
  binding,
  onChange,
  label,
  takenBy,
  allowMouse = false,
  hideLabel = false,
  onRefusedChange,
}: PttBindingFieldProps) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [attempted, setAttempted] = useState<PttBinding | null>(null);
  const takenByRef = useRef(takenBy);
  const tRef = useRef(t);
  takenByRef.current = takenBy;
  // Same for onChange: a parent that re-renders mid-capture (the Voz level
  // meter does, every frame) hands a new arrow each time, and with it in the
  // effect's deps the listeners were rebuilt between a lone modifier's keydown
  // and keyup, which lost the pending modifier and saved nothing.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  tRef.current = t;

  useEffect(() => {
    if (!capturing) {
      return;
    }

    let pendingModifier: KeyboardEvent | null = null;

    function commit(outcome: { ok: true; binding: PttBinding } | { ok: false; reason: "refused" }) {
      if (!outcome.ok) {
        setRefused(tRef.current("keyBinding.refused"));
        return;
      }
      const taken = takenByRef.current?.(outcome.binding);
      if (taken) {
        setRefused(tRef.current("keyBinding.conflict", { action: taken }));
        setAttempted(outcome.binding);
        setCapturing(false);
        return;
      }
      setRefused(null);
      setCapturing(false);
      onChangeRef.current(outcome.binding);
    }

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        setCapturing(false);
        setRefused(null);
        return;
      }

      if (isModifierCode(event.code)) {
        pendingModifier = event;
        return;
      }
      pendingModifier = null;
      commit(capturePttKeyboardBinding(event));
    }

    function onKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!pendingModifier || pendingModifier.code !== event.code) {
        return;
      }
      pendingModifier = null;
      const next = capturePttModifierBinding(event);
      const taken = takenByRef.current?.(next);
      if (taken) {
        setRefused(tRef.current("keyBinding.conflict", { action: taken }));
        setAttempted(next);
        setCapturing(false);
        return;
      }
      setRefused(null);
      setCapturing(false);
      onChangeRef.current(next);
    }

    function onMouseDown(event: MouseEvent) {
      if (!allowMouse) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      commit(captureMouseBinding(event.button));
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    if (allowMouse) {
      window.addEventListener("mousedown", onMouseDown, true);
    }
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (allowMouse) {
        window.removeEventListener("mousedown", onMouseDown, true);
      }
    };
  }, [capturing, allowMouse]);

  useEffect(() => {
    setRefused(null);
    setAttempted(null);
  }, [binding]);

  return (
    <BindingControl
      label={label}
      binding={attempted ?? binding}
      capturing={capturing}
      prompt={t(allowMouse ? "keyBinding.pressOrClick" : "keyBinding.press")}
      refused={refused}
      hideLabel={hideLabel}
      onRefusedChange={onRefusedChange}
      onToggle={() => {
        setRefused(null);
        setAttempted(null);
        setCapturing((prev) => !prev);
      }}
      // Leaving the field drops a refused combo: it was never saved, and a
      // red key left on the row reads as if it were.
      onBlur={() => {
        setCapturing(false);
        setRefused(null);
        setAttempted(null);
      }}
    />
  );
}
