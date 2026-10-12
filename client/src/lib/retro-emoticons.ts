/**
 * Modo 2005's text shortcuts: `(H)` reads as 😎, `:)` as 🙂, the way people
 * typed in 2005. Unicode emoji the reader's own system draws; no image from
 * any other product.
 *
 * RENDER-TIME ONLY, and only for a reader in the look. The stored message is
 * exactly what the person typed, so a friend outside Modo 2005 still sees
 * `(H)`, and leaving the look gives every message its text back.
 *
 * Left alone: code spans and blocks (not `text` nodes), links and anything
 * inside them, mentions, and URLs written as plain text (`http://x.com/(L)`).
 * A punctuation code like `:)` needs a gap on both sides, so `a:)b`, a time
 * like `10:30` or Python's `x[:D]` stays as typed; a bracket code like `(H)`
 * must not touch a letter or digit, so `f(x)` and `abc(L)` stay too.
 */

export const RETRO_EMOTICONS: ReadonlyArray<readonly [string, string]> = [
  [":)", "🙂"],
  [":D", "😃"],
  [";)", "😉"],
  [":P", "😛"],
  ["(H)", "😎"],
  [":@", "😠"],
  [":$", "😳"],
  [":S", "😕"],
  [":(", "🙁"],
  [":'(", "😢"],
  ["(A)", "😇"],
  ["(6)", "😈"],
  ["(L)", "❤️"],
  ["(U)", "💔"],
  ["(K)", "💋"],
  ["(F)", "🌹"],
  ["(Y)", "👍"],
  ["(N)", "👎"],
  ["(8)", "🎵"],
  ["(*)", "⭐"],
  ["(B)", "🍺"],
  ["(C)", "☕"],
  ["(^)", "🎂"],
  ["(G)", "🎁"],
  ["(S)", "🌙"],
  ["(#)", "☀️"],
  ["(R)", "🌈"],
  ["(sn)", "🐌"],
  ["(@)", "🐱"],
  ["(&)", "🐶"],
  ["(bah)", "🐑"],
  ["(pi)", "🍕"],
];

const BY_CODE = new Map(
  RETRO_EMOTICONS.map(([code, emoji]) => [code.toLowerCase(), emoji]),
);

const PATTERN = new RegExp(
  [...BY_CODE.keys()]
    .sort((a, b) => b.length - a.length)
    .map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gi",
);

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
const WORDISH = /[\p{L}\p{N}_/]/u;
const OPEN_BEFORE = /[\s("'“]/;
const CLOSE_AFTER = /[\s.,!?;:)\]}"'”]/;

function replaceInPlainText(text: string): string {
  return text.replace(PATTERN, (match, offset: number, whole: string) => {
    const before = offset > 0 ? whole[offset - 1]! : "";
    const after = whole[offset + match.length] ?? "";
    if (match.startsWith("(")) {
      if ((before && WORDISH.test(before)) || (after && WORDISH.test(after))) {
        return match;
      }
    } else if (
      (before && !OPEN_BEFORE.test(before)) ||
      (after && !CLOSE_AFTER.test(after))
    ) {
      return match;
    }
    return BY_CODE.get(match.toLowerCase()) ?? match;
  });
}

/** A plain string, URLs skipped. */
export function replaceEmoticons(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    out += replaceInPlainText(text.slice(last, index)) + match[0];
    last = index + match[0].length;
  }
  return out + replaceInPlainText(text.slice(last));
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string };
}

const OPAQUE_PARENTS = new Set(["link", "linkReference", "definition"]);

/** The remark plugin `MessageBody` adds while the reader is in Modo 2005. */
export function remarkRetroEmoticons() {
  return (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (!node.children || OPAQUE_PARENTS.has(node.type)) {
        return;
      }
      for (const child of node.children) {
        if (child.type === "text") {
          // A mention is a text node that `remarkMentions` tagged as a span.
          if (!child.data?.hName && child.value) {
            child.value = replaceEmoticons(child.value);
          }
          continue;
        }
        walk(child);
      }
    }
    if (tree) {
      walk(tree);
    }
  };
}
