import { useEffect, useId, useRef, useState } from "react";
import {
  SETTINGS_INSET_FOCUS,
  SETTINGS_TRANSITION,
  SettingsInlineStatus,
  SettingsKeyCombo,
} from "@/components/settings/kit";
import {
  captureBinding,
  capturePttKeyboardBinding,
  capturePttModifierBinding,
  captureMouseBinding,
  isModifierCode,
  keyDisplayLabel,
  metaKeyName,
  type KeyBinding,
  type KeyNameTranslator,
  type PttBinding,
} from "@/components/voice/push-to-talk";
import { isApplePlatform } from "@/lib/composer-formatting";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A binding as one label per keycap, plus the words a screen reader says for
 * the whole combo.
 *
 * Apple keyboards print their modifiers as glyphs, in the order the system
 * menus use: control, option, shift, command (so Shift + Cmd + M is ⇧⌘M).
 * Everywhere else it reads Ctrl, Alt, Shift, in that order, and the fourth
 * modifier is the Windows key. `apple` is a parameter so a test can ask for
 * both without faking the browser. A key that is a modifier is named for this
 * platform, and in the person's language when `translate` is given.
 */
export function bindingKeycaps(
  binding: KeyBinding,
  apple: boolean = isApplePlatform(),
  translate?: KeyNameTranslator,
): { keys: string[]; label: string } {
  const modifiers: Array<[boolean, string, string]> = apple
    ? [
        [binding.ctrl, "⌃", "Control"],
        [binding.alt, "⌥", "Option"],
        [binding.shift, "⇧", "Shift"],
        [binding.meta, "⌘", "Command"],
      ]
    : [
        [binding.ctrl, "Ctrl", "Ctrl"],
        [binding.alt, "Alt", "Alt"],
        [binding.shift, "Shift", "Shift"],
        [binding.meta, metaKeyName(false), metaKeyName(false)],
      ];
  const held = modifiers.filter(([on]) => on);
  const key = keyDisplayLabel(binding, translate, apple);
  return {
    keys: [...held.map(([, glyph]) => glyph), key],
    label: [...held.map(([, , word]) => word), key].join(" + "),
  };
}

/** A refusal the field reports instead of drawing, and the id to draw it under. */
export interface KeyBindingRefusal {
  message: string;
  id: string;
  /**
   * Set when the chord was refused because another action owns it: the chord
   * that was pressed. The field stays armed, so the caller can offer to swap.
   */
  attempted?: KeyBinding;
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
  /**
   * Makes Enter take the chord that was just refused as "in use", for a
   * caller that offers to swap it with the other action. Enter is a reserved
   * key everywhere else, so it is free for this while a conflict shows.
   */
  onSwap?: (binding: KeyBinding) => void;
  /**
   * Which chords `onSwap` can take. Without it every chord the field refuses
   * as in use is offered the swap, and the message says Enter does it.
   */
  canSwap?: (binding: KeyBinding) => boolean;
}

type CaptureResult<B> = { ok: true; binding: B } | { ok: false };

/** Two bindings that press the same keys, whatever object they live in. */
function bindingId(binding: KeyBinding): string {
  return [
    binding.code,
    binding.ctrl ? 1 : 0,
    binding.alt ? 1 : 0,
    binding.shift ? 1 : 0,
    binding.meta ? 1 : 0,
  ].join("|");
}

interface CaptureOptions<B extends KeyBinding> {
  binding: B;
  onChange: (binding: B) => void;
  takenBy?: (binding: B) => string | null;
  /** A keydown that is not a modifier, as a binding, or refused. */
  fromKey: (event: KeyboardEvent) => CaptureResult<B>;
  /**
   * A modifier released on its own. Without it a lone modifier is refused,
   * which is right for an action that fires once (Ctrl alone is not a shortcut
   * anybody means) and wrong for push-to-talk, where holding Ctrl is a fine key.
   */
  fromModifier?: (event: KeyboardEvent) => B;
  /** A mousedown, for a field that takes mouse buttons. */
  fromMouse?: (button: number) => CaptureResult<B>;
  onSwap?: (binding: B) => void;
  /** Whether Enter may swap this chord. Defaults to yes when `onSwap` is set. */
  canSwap?: (binding: B) => boolean;
}

/** What the field refused, kept as data so the words follow the language. */
type Refusal =
  | { kind: "message"; message: string }
  | { kind: "conflict"; action: string; swap: boolean };

/**
 * The "press something to bind it" state machine both fields share.
 *
 * Capture runs on the window in the capture phase so the keystroke never
 * reaches the app underneath while binding. Whatever is refused (a reserved
 * key, a lone modifier, a chord another action owns) is said and the field
 * stays armed, so the next press is a second try and the field never reads as
 * half-changed. Esc or leaving the field ends it.
 */
function useBindingCapture<B extends KeyBinding>(options: CaptureOptions<B>) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // The chord that was refused because another action owns it. Never saved;
  // handed up so the row can offer to swap, and Enter takes it.
  const [attempted, setAttempted] = useState<B | null>(null);
  // The listeners read everything through refs. A parent that re-renders
  // mid-capture (the Voz level meter does, every frame) hands new arrows each
  // time, and with them in the effect's deps the listeners were rebuilt between
  // a lone modifier's keydown and keyup, which lost the pending modifier and
  // saved nothing.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const tRef = useRef(t);
  tRef.current = t;
  const attemptedRef = useRef(attempted);
  attemptedRef.current = attempted;
  const mouse = options.fromMouse !== undefined;

  useEffect(() => {
    if (!capturing) {
      return;
    }

    // A modifier is only a binding if it is released without anything else
    // being pressed, otherwise "Ctrl" would swallow every chord starting with
    // it and "Ctrl + Q" could never be bound.
    let pendingModifier: KeyboardEvent | null = null;

    function end() {
      setCapturing(false);
      setRefusal(null);
      setAttempted(null);
    }

    function refuse(message: string) {
      setRefusal({ kind: "message", message });
      setAttempted(null);
    }

    function swapOffered(next: B): boolean {
      const { onSwap, canSwap } = optionsRef.current;
      return onSwap !== undefined && (canSwap ? canSwap(next) : true);
    }

    function offer(next: B) {
      const taken = optionsRef.current.takenBy?.(next);
      if (taken) {
        setRefusal({ kind: "conflict", action: taken, swap: swapOffered(next) });
        setAttempted(next);
        return;
      }
      end();
      optionsRef.current.onChange(next);
    }

    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.code === "Escape") {
        end();
        return;
      }

      const pending = attemptedRef.current;
      if (event.code === "Enter" && pending && swapOffered(pending)) {
        end();
        optionsRef.current.onSwap?.(pending);
        return;
      }

      if (isModifierCode(event.code)) {
        pendingModifier = event;
        return;
      }
      pendingModifier = null;

      const outcome = optionsRef.current.fromKey(event);
      if (!outcome.ok) {
        refuse(tRef.current("keyBinding.refused"));
        return;
      }
      offer(outcome.binding);
    }

    function onKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!pendingModifier || pendingModifier.code !== event.code) {
        return;
      }
      pendingModifier = null;
      const fromModifier = optionsRef.current.fromModifier;
      if (!fromModifier) {
        refuse(tRef.current("keyBinding.loneModifier"));
        return;
      }
      offer(fromModifier(event));
    }

    function onMouseDown(event: MouseEvent) {
      const fromMouse = optionsRef.current.fromMouse;
      if (!fromMouse) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const outcome = fromMouse(event.button);
      if (!outcome.ok) {
        refuse(tRef.current("keyBinding.refused"));
        return;
      }
      offer(outcome.binding);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    if (mouse) {
      window.addEventListener("mousedown", onMouseDown, true);
    }
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (mouse) {
        window.removeEventListener("mousedown", onMouseDown, true);
      }
    };
  }, [capturing, mouse]);

  // A new binding (saved here, swapped from the row, reset to default) ends
  // the capture. Compared by the keys it presses, so a parent that rebuilds
  // an equal object each render does not cancel a capture in progress.
  const current = bindingId(options.binding);
  useEffect(() => {
    setCapturing(false);
    setRefusal(null);
    setAttempted(null);
  }, [current]);

  const refused =
    refusal === null
      ? null
      : refusal.kind === "message"
        ? refusal.message
        : t(refusal.swap ? "keyBinding.conflictSwap" : "keyBinding.conflict", {
            action: refusal.action,
          });

  return {
    capturing,
    refused,
    attempted,
    toggle: () => {
      setRefusal(null);
      setAttempted(null);
      setCapturing((prev) => !prev);
    },
    // Leaving the field ends capture, rather than leaving the window silently
    // eating every keystroke, and drops what was refused: it was never saved,
    // and a message left on the row reads as if it were.
    blur: () => {
      setCapturing(false);
      setRefusal(null);
      setAttempted(null);
    },
  };
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
 * Every key is `preventDefault`ed while armed, so binding "S" does not open
 * the browser's save dialog on the way past. A modifier on its own is refused
 * here: this field is for actions that fire once.
 */
export function KeyBindingField({
  binding,
  onChange,
  label,
  takenBy,
  onSwap,
  canSwap,
  hideLabel = false,
  onRefusedChange,
}: KeyBindingFieldProps) {
  const { t } = useTranslation();
  const capture = useBindingCapture<KeyBinding>({
    binding,
    onChange,
    takenBy,
    onSwap,
    canSwap,
    fromKey: captureBinding,
  });

  return (
    <BindingControl
      label={label}
      binding={binding}
      capturing={capture.capturing}
      prompt={t("keyBinding.press")}
      refused={capture.refused}
      attempted={capture.attempted}
      hideLabel={hideLabel}
      onRefusedChange={onRefusedChange}
      onToggle={capture.toggle}
      onBlur={capture.blur}
    />
  );
}

/**
 * What both fields draw: the binding as keycaps in one well, which is itself
 * the button that arms capture, and the refusal under it.
 *
 * Armed, the well keeps showing the current binding, dimmed, beside the
 * prompt: nothing has changed until a valid chord is accepted, and a refusal
 * must not read as if it had.
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
  attempted,
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
  attempted: KeyBinding | null;
  hideLabel: boolean;
  onRefusedChange?: (refusal: KeyBindingRefusal | null) => void;
  onToggle: () => void;
  onBlur: () => void;
}) {
  const refusedId = useId();
  const { t } = useTranslation();
  const combo = bindingKeycaps(binding, undefined, t);
  const reportRef = useRef(onRefusedChange);
  reportRef.current = onRefusedChange;
  const reports = onRefusedChange !== undefined;

  useEffect(() => {
    reportRef.current?.(
      refused
        ? { message: refused, id: refusedId, attempted: attempted ?? undefined }
        : null,
    );
  }, [refused, attempted, refusedId]);

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
          <span className="flex min-w-0 items-center gap-2 pr-2.5">
            <SettingsKeyCombo
              keys={combo.keys}
              className="shrink-0 opacity-50"
            />
            <span className="py-1.5 text-xs text-pretty text-text-secondary">
              {prompt}
            </span>
          </span>
        ) : (
          <SettingsKeyCombo keys={combo.keys} label={combo.label} />
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
  const capture = useBindingCapture<PttBinding>({
    binding,
    onChange,
    takenBy,
    fromKey: capturePttKeyboardBinding,
    fromModifier: capturePttModifierBinding,
    fromMouse: allowMouse ? captureMouseBinding : undefined,
  });

  return (
    <BindingControl
      label={label}
      binding={binding}
      capturing={capture.capturing}
      prompt={t(allowMouse ? "keyBinding.pressOrClick" : "keyBinding.press")}
      refused={capture.refused}
      attempted={capture.attempted}
      hideLabel={hideLabel}
      onRefusedChange={onRefusedChange}
      onToggle={capture.toggle}
      onBlur={capture.blur}
    />
  );
}
