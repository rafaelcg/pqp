/**
 * What a message carries below its body (s-message-content): a forward, a
 * link preview, a poll, a file, a voice note. Under the redesign every one of
 * them is the same card (`ui/card.tsx`): the card's text tint and edge at the
 * card radius, no coloured stripe and no shadow, so a message with three
 * things in it reads as one family. Each is appended last, after the card's
 * toggle-off look, through `cn`.
 */
export const CONTENT_CARD_REDESIGN =
  "redesign:rounded-[var(--radius-card)] redesign:border redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:bg-none redesign:shadow-[var(--content-card-shadow)]";

/** The hover of a card that is a link or a button: a text tint, never lime. */
export const CONTENT_CARD_HOVER_REDESIGN =
  "redesign:hover:border-[color:var(--card-border)] redesign:hover:bg-[color:var(--content-card-hover)]";

/** Keyboard focus on a card that is a link or a button. */
export const CONTENT_CARD_FOCUS_REDESIGN =
  "redesign:focus-visible:outline-none redesign:focus-visible:ring-2 redesign:focus-visible:ring-accent";

/** A picture or a player: the media radius, the card's edge, no hover tint. */
export const CONTENT_MEDIA_REDESIGN =
  "redesign:rounded-[var(--content-media-radius)] redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)]";

/** The 36px tile a file's glyph sits on, inside a card. */
export const CONTENT_GLYPH_TILE_REDESIGN =
  "redesign:flex redesign:h-9 redesign:w-9 redesign:shrink-0 redesign:items-center redesign:justify-center redesign:rounded-[var(--radius-control)] redesign:bg-[color:var(--content-glyph-bg)] redesign:text-text-secondary";

/** The small line on a card naming where it came from: tertiary text, sentence case. */
export const CONTENT_KICKER_REDESIGN =
  "redesign:text-xs redesign:normal-case redesign:tracking-normal redesign:text-text-tertiary";
