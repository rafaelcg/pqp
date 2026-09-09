import { useCallback, useEffect, useRef, useState } from "react";
import {
  CUSTOM_STATUS_MAX_LENGTH,
  customStatusLength,
  normalizeCustomStatus,
  validateCustomStatus,
  type User,
} from "@pqp/shared";
import { updateMe } from "@/lib/api";
import { translateMessage } from "@/lib/i18n";

/**
 * O recado: the account's own copy of the line it wrote under its own name.
 *
 * SHAPED AFTER `useUserStatus`, deliberately, because the control sits directly
 * under that one in the same popover and the two have to behave the same way.
 * Optimistic, then rolled back on failure with the failure SHOWN, rather than
 * fire-and-forget. A recado that silently failed to save is somebody believing
 * the room has been told they are away for lunch.
 *
 * WHY THE SERVER'S ANSWER WINS ON READ. The write goes through `PATCH /api/me`,
 * which normalises (whitespace collapsed, ends trimmed) before storing, so what
 * comes back is not always what was typed. Adopting the response rather than
 * the draft is what stops a trailing space living on screen in one tab and
 * nowhere else.
 *
 * The `profile-update` frame the same write fans out also reaches this client
 * and updates `user`, which is where `stored` comes from. That is a second,
 * slower path to the same value and it is not relied on: a person on a dropped
 * socket must still see their own recado change.
 */

export interface CustomStatusControls {
  /** The value other people are being shown. Empty string means none. */
  value: string;
  /** A write is in flight. */
  saving: boolean;
  /** Set when the write failed and `value` was rolled back to the truth. */
  error: string | null;
  /**
   * Save a new recado. An empty or all-whitespace string clears it.
   *
   * Returns nothing and never rejects: every outcome is reflected in `saving`,
   * `error` and `value`, so a caller cannot forget to handle one.
   */
  save: (next: string) => void;
  /** Drop a stale error, for a field that has just been reopened. */
  clearError: () => void;
}

export interface UseCustomStatusOptions {
  /**
   * The stored recado from `/api/me` and from later `profile-update` frames, or
   * null before bootstrap resolves. The account's own copy is authoritative on
   * read: another device may have changed it since this tab loaded.
   */
  stored: string | null;
  /**
   * Hands the merged account back to the shell after a successful write.
   *
   * Not optional convenience: `PATCH /api/me` answers with the whole account,
   * and the shell's `user` object feeds the settings form and the panel. The
   * broadcast frame would eventually do the same job, but only for a client
   * whose socket is up, and this control must work on a flapping connection.
   */
  onUserUpdated: (user: User) => void;
}

export function useCustomStatus({
  stored,
  onUserUpdated,
}: UseCustomStatusOptions): CustomStatusControls {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt the stored value once it lands, and on every later change from
  // another device. Skipped while a write is in flight for the same reason
  // `useUserStatus` skips it: an `/api/me` response that was already on its way
  // must not overwrite what the person just typed.
  const savingRef = useRef(false);
  useEffect(() => {
    if (!savingRef.current) {
      setValue(stored ?? "");
    }
  }, [stored]);

  const onUserUpdatedRef = useRef(onUserUpdated);
  onUserUpdatedRef.current = onUserUpdated;

  const save = useCallback(
    (next: string) => {
      setError(null);
      // Normalised here as well as on the server, so the no-op check below is
      // made against the value that would actually be stored. Without it,
      // blurring a field whose only change is a trailing space is a round trip.
      const wanted = normalizeCustomStatus(next);
      if (wanted === value) {
        return;
      }
      // Refused before the request rather than after, because the server's
      // answer for an over-long body is a 400 whose message is in neither of
      // the two languages this app speaks.
      const rejection = validateCustomStatus(wanted);
      if (rejection) {
        setError(
          translateMessage(
            rejection === "length"
              ? "customStatus.tooLong"
              : "customStatus.badCharacters",
            { max: CUSTOM_STATUS_MAX_LENGTH },
          ),
        );
        return;
      }

      const previous = value;
      setValue(wanted);
      setSaving(true);
      savingRef.current = true;
      // Empty is sent as an explicit null rather than as `""`: null is the
      // documented "clear it" on the wire, and one spelling for one intent is
      // what keeps the server from having to accept two.
      void updateMe({ customStatus: wanted === "" ? null : wanted })
        .then((updated) => {
          setValue(updated.customStatus ?? "");
          onUserUpdatedRef.current(updated);
        })
        .catch(() => {
          setValue(previous);
          setError(translateMessage("customStatus.saveFailed"));
        })
        .finally(() => {
          setSaving(false);
          savingRef.current = false;
        });
    },
    [value],
  );

  const clearError = useCallback(() => setError(null), []);

  return { value, saving, error, save, clearError };
}

/**
 * How many characters are left, for the counter under the field.
 *
 * Counted against the NORMALISED value, which is what the cap is applied to, so
 * a run of spaces in the middle of a draft does not tick the number down twice.
 * Negative when the draft is over, which is what the field renders in red.
 */
export function customStatusRemaining(draft: string): number {
  return CUSTOM_STATUS_MAX_LENGTH - customStatusLength(normalizeCustomStatus(draft));
}
