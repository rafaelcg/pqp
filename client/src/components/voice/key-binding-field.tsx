import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  captureBinding,
  captureModifier,
  formatBinding,
  isModifierCode,
  type KeyBinding,
} from "@/components/voice/push-to-talk";

interface KeyBindingFieldProps {
  binding: KeyBinding;
  onChange: (binding: KeyBinding) => void;
  label: string;
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
}: KeyBindingFieldProps) {
  const [capturing, setCapturing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

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
        setRefused(
          "That key is reserved — Tab, Enter, Escape and Backspace stay with the app.",
        );
        return;
      }
      setRefused(null);
      setCapturing(false);
      onChange(outcome.binding);
    }

    function onKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!pendingModifier || pendingModifier.code !== event.code) {
        return;
      }
      pendingModifier = null;
      setRefused(null);
      setCapturing(false);
      onChange(captureModifier(event));
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [capturing, onChange]);

  return (
    <div className="space-y-1.5">
      <span className="block text-xs uppercase tracking-wide text-paper-muted">
        {label}
      </span>
      <Button
        type="button"
        variant="secondary"
        className="w-full justify-start font-mono"
        aria-live="polite"
        // The pressed state is what tells a screen reader the field is armed
        // and swallowing keys, which is otherwise invisible.
        aria-pressed={capturing}
        onClick={() => {
          setRefused(null);
          setCapturing((prev) => !prev);
        }}
        // Clicking away ends capture rather than leaving the window silently
        // eating every keystroke.
        onBlur={() => setCapturing(false)}
      >
        <Keyboard className="h-4 w-4 shrink-0" aria-hidden="true" />
        {capturing ? "Press any key… (Esc cancels)" : formatBinding(binding)}
      </Button>
      {refused && (
        <p role="status" className="text-xs text-warning">
          {refused}
        </p>
      )}
    </div>
  );
}
