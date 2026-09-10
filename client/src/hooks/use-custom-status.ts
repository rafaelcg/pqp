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
 *
 * WRITES ARE SERIALISED. Enter saves and then blurs, and clear stays clickable
 * while a PATCH is in flight, so two calls can race. A generation counter
 * ignores a stale response; a one-slot queue keeps the latest intended value
 * and sends it when the in-flight write settles. Duplicate Enter/blur of the
 * same normalised string is a no-op against that intended value, not against
 * React state that has not re-rendered yet.
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

  const savingRef = useRef(false);
  const intendedRef = useRef("");
  const persistedRef = useRef("");
  const queuedRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const onUserUpdatedRef = useRef(onUserUpdated);
  onUserUpdatedRef.current = onUserUpdated;

  // Adopt the stored value once it lands, and on every later change from
  // another device. Skipped while a write is in flight for the same reason
  // `useUserStatus` skips it: an `/api/me` response that was already on its way
  // must not overwrite what the person just typed.
  useEffect(() => {
    if (!savingRef.current) {
      const next = stored ?? "";
      setValue(next);
      intendedRef.current = next;
      persistedRef.current = next;
    }
  }, [stored]);

  const flush = useCallback((wanted: string) => {
    const generation = ++generationRef.current;
    savingRef.current = true;
    setSaving(true);
    // Empty is sent as an explicit null rather than as `""`: null is the
    // documented "clear it" on the wire, and one spelling for one intent is
    // what keeps the server from having to accept two.
    void updateMe({ customStatus: wanted === "" ? null : wanted })
      .then((updated) => {
        if (generation !== generationRef.current) {
          return;
        }
        persistedRef.current = updated.customStatus ?? "";
        onUserUpdatedRef.current(updated);
        const queued = queuedRef.current;
        if (queued !== null) {
          queuedRef.current = null;
          flush(queued);
          return;
        }
        setValue(persistedRef.current);
        intendedRef.current = persistedRef.current;
      })
      .catch(() => {
        if (generation !== generationRef.current) {
          return;
        }
        const queued = queuedRef.current;
        if (queued !== null) {
          queuedRef.current = null;
          flush(queued);
          return;
        }
        setValue(persistedRef.current);
        intendedRef.current = persistedRef.current;
        setError(translateMessage("customStatus.saveFailed"));
      })
      .finally(() => {
        if (generation !== generationRef.current) {
          return;
        }
        savingRef.current = false;
        setSaving(false);
      });
  }, []);

  const save = useCallback(
    (next: string) => {
      setError(null);
      // Normalised here as well as on the server, so the no-op check below is
      // made against the value that would actually be stored. Without it,
      // blurring a field whose only change is a trailing space is a round trip.
      const wanted = normalizeCustomStatus(next);
      // Against the intended value, not React state: Enter saves and then
      // blurs in the same turn, before the render that would make `value`
      // match, and that pair must not fire two PATCHes for one string.
      if (wanted === intendedRef.current) {
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

      intendedRef.current = wanted;
      setValue(wanted);
      if (savingRef.current) {
        queuedRef.current = wanted;
        return;
      }
      flush(wanted);
    },
    [flush],
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
