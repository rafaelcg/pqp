import { MessageBody } from "@/components/chat/message-body";
import { cn } from "@/lib/utils";

export const COMPOSER_FORMAT_PREVIEW_ID = "composer-format-preview";

/**
 * Live look of the draft while the format bar is open.
 *
 * The composer stays a textarea (Enter, IME, `@` `:` `/` autocomplete). This
 * is the same markdown path the bubble uses, so bold / italic / strike / code
 * look like the sent message. The source still holds the markers; this only
 * paints them.
 *
 * `inField` is the redesign's placement: inside the field's own column, right
 * above the textarea, so the preview's text starts at the field's text (the
 * field's `px-4`, less the card's 1px border). The caller shows it there only
 * when the draft has markup (`draftNeedsPreview`).
 */
export function ComposerFormatPreview({
  body,
  label,
  onActivate,
  inField = false,
  fontSize,
}: {
  body: string;
  label: string;
  onActivate: () => void;
  inField?: boolean;
  /** The field's own size, so the two match where the field is floored at 16px. */
  fontSize?: string;
}) {
  if (!body) {
    return null;
  }

  return (
    <div
      id={COMPOSER_FORMAT_PREVIEW_ID}
      role="region"
      aria-label={label}
      data-composer-format-preview={inField ? "field" : ""}
      style={fontSize ? { fontSize } : undefined}
      className={cn(
        "markdown-body mb-2 max-h-[200px] cursor-text overflow-y-auto rounded-[var(--radius-control)] bg-surface-3/60 py-2 text-[length:var(--chat-font-size)] leading-[var(--chat-line-height)] text-text/90 redesign:rounded-[var(--radius-card)] redesign:border redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:text-text",
        // The field's text is `px-4`; the card's 1px border is the other pixel.
        inField ? "mb-1 mt-1 px-[15px]" : "px-3",
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      <MessageBody body={body} currentUsername={null} />
    </div>
  );
}
