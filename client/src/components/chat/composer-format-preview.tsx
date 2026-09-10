import { MessageBody } from "@/components/chat/message-body";

export const COMPOSER_FORMAT_PREVIEW_ID = "composer-format-preview";

/**
 * Live look of the draft while the format bar is open.
 *
 * The composer stays a textarea (Enter, IME, `@` `:` `/` autocomplete). This
 * is the same markdown path the bubble uses, so bold / italic / strike / code
 * look like the sent message. The source still holds the markers; this only
 * paints them.
 */
export function ComposerFormatPreview({
  body,
  label,
  onActivate,
}: {
  body: string;
  label: string;
  onActivate: () => void;
}) {
  if (!body) {
    return null;
  }

  return (
    <div
      id={COMPOSER_FORMAT_PREVIEW_ID}
      role="region"
      aria-label={label}
      className="markdown-body mb-2 max-h-[200px] cursor-text overflow-y-auto rounded-[var(--radius-control)] bg-surface-3/60 px-3 py-2 text-[length:var(--chat-font-size)] leading-[var(--chat-line-height)] text-text/90"
      onPointerDown={(event) => {
        event.preventDefault();
        onActivate();
      }}
    >
      <MessageBody body={body} currentUsername={null} />
    </div>
  );
}
