import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A group's closing row with no label: a short note and one button, for
 * example Feedback's "Vai junto: …" beside "Enviar". The note is tertiary text
 * on the left, the action on the right; on a phone the action wraps under the
 * note. Not registered (it has no label); `id`, when given, is still a
 * `data-settings-row` target for `openSection`.
 */
export function SettingsActionRow({
  id,
  note,
  noteId,
  children,
}: {
  id?: string;
  /** Tertiary text. Pass `noteId` and point the button's `aria-describedby` at it. */
  note?: ReactNode;
  noteId?: string;
  /** The action: one `Button`, usually the tab's single primary. */
  children: ReactNode;
}) {
  return (
    <div
      data-settings-row={id}
      className={cn(
        "flex min-h-11 flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3",
        note ? "justify-between" : "justify-end",
      )}
    >
      {note ? (
        <p id={noteId} className="min-w-0 flex-1 basis-48 text-xs text-pretty text-text-tertiary">
          {note}
        </p>
      ) : null}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
