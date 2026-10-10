/**
 * `#channel` references inside a Baú post.
 *
 * A reference is stored as `<#channelId>` (the channel's uuid), never as its
 * name. Two reasons, both about trust: a rename must not break the link, and a
 * body that holds only an id cannot leak the name of a private channel to a
 * reader who cannot see it. Readers resolve the id against the channels they
 * can already see; anything they cannot resolve is drawn as a neutral
 * placeholder.
 *
 * The same text is parsed by the web client, the two native apps and the
 * translation job, so the grammar lives here and is deliberately tiny.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** Global; build a fresh RegExp from `.source` when using `exec` state. */
export const CHANNEL_REF_PATTERN = new RegExp(`<#(${UUID})>`, "gi");

export function channelRef(channelId: string): string {
  return `<#${channelId.toLowerCase()}>`;
}

export type ChannelRefPart =
  | { type: "text"; value: string }
  | { type: "channel"; id: string };

/** Cuts a body into plain text and channel references, in order. */
export function splitChannelRefs(text: string): ChannelRefPart[] {
  const parts: ChannelRefPart[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(CHANNEL_REF_PATTERN))) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ type: "text", value: text.slice(last, index) });
    }
    parts.push({ type: "channel", id: match[1]!.toLowerCase() });
    last = index + match[0].length;
  }
  if (last < text.length) {
    parts.push({ type: "text", value: text.slice(last) });
  }
  return parts;
}

export function hasChannelRefs(text: string | null | undefined): boolean {
  return Boolean(text) && new RegExp(CHANNEL_REF_PATTERN).test(text!);
}

/** `<#id>` references become `#name` where the id is known, and vanish nowhere. */
export function channelRefsToPlain(
  text: string,
  nameOf: (channelId: string) => string | null,
): string {
  return splitChannelRefs(text)
    .map((part) => {
      if (part.type === "text") {
        return part.value;
      }
      const name = nameOf(part.id);
      return name ? `#${name}` : "#channel";
    })
    .join("");
}

/**
 * Translation guard. An automatic translator sees prose; a 36-character uuid
 * in angle brackets is something it may "fix", drop or translate. Swap every
 * reference for a short numbered placeholder of the same shape (`<#1>`) before
 * the text goes out and put the ids back afterwards.
 *
 * `restore(translated, sent)` answers null for a field whose placeholders did
 * not all come back exactly as many times as they went out, so the caller keeps
 * the author's own text for that field rather than publish a post whose link
 * points nowhere. `sent` is what was actually sent (after any truncation);
 * it defaults to the full protected texts.
 */
export interface ProtectedChannelRefs {
  texts: string[];
  restore: (translated: string[], sent?: string[]) => Array<string | null>;
}

const PLACEHOLDER = /<#(\d{1,3})>/g;

function placeholderNumbers(text: string): number[] {
  return [...text.matchAll(PLACEHOLDER)]
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function protectChannelRefs(texts: string[]): ProtectedChannelRefs {
  const ids: string[] = [];

  const protectedTexts = texts.map((text) =>
    text.replace(new RegExp(CHANNEL_REF_PATTERN), (_all, rawId: string) => {
      const id = rawId.toLowerCase();
      let n = ids.indexOf(id);
      if (n === -1) {
        ids.push(id);
        n = ids.length - 1;
      }
      return `<#${n + 1}>`;
    }),
  );

  // A source that already contains `<#1>` as literal text would be
  // indistinguishable from a placeholder: refuse to restore anything.
  const collides = texts.some((text) => /<#\d{1,3}>/.test(text));

  return {
    texts: protectedTexts,
    restore(translated, sent = protectedTexts) {
      return sent.map((sentText, i) => {
        if (collides) {
          return null;
        }
        const translatedText = translated[i];
        if (translatedText === undefined) {
          return null;
        }
        const expected = placeholderNumbers(sentText);
        const found = placeholderNumbers(translatedText).filter(
          (n) => n >= 1 && n <= ids.length,
        );
        if (
          expected.length !== found.length ||
          expected.some((n, k) => n !== found[k])
        ) {
          return null;
        }
        return translatedText.replace(
          new RegExp(PLACEHOLDER),
          (all, num: string) => {
            const n = Number(num);
            return n >= 1 && n <= ids.length ? `<#${ids[n - 1]}>` : all;
          },
        );
      });
    },
  };
}
