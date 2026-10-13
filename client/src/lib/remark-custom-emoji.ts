import { CUSTOM_EMOJI_TOKEN_PATTERN } from "@pqp/shared";

/**
 * `<:name:id>` inside rendered markdown.
 *
 * A known id becomes a `span` carrying only the id; the message body renders
 * the picture from the server's own list (`CustomEmojiImage`), so the URL never
 * comes from the text a sender typed and `img` stays off the markdown
 * allowlist. An id this server does not have (deleted, or from another server)
 * reads as the `:name:` that was typed.
 *
 * Code spans and fenced code are not `text` nodes, so a token inside them is
 * left literal, which is what a person quoting one wants.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
  };
}

const OPAQUE_PARENTS = new Set(["link", "linkReference", "definition"]);

export const CUSTOM_EMOJI_CLASS = "pqp-custom-emoji";

function splitTextNode(
  node: MdastNode,
  isKnown: (id: string) => boolean,
  onUnknown: () => void,
): MdastNode[] | null {
  const value = node.value ?? "";
  if (!value.includes("<:")) {
    return null;
  }
  const parts: MdastNode[] = [];
  let lastIndex = 0;
  let found = false;

  for (const match of value.matchAll(new RegExp(CUSTOM_EMOJI_TOKEN_PATTERN))) {
    const index = match.index ?? 0;
    const name = match[1]!;
    const id = match[2]!;
    found = true;
    if (index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, index) });
    }
    if (isKnown(id)) {
      parts.push({
        type: "text",
        value: `:${name}:`,
        data: {
          hName: "span",
          hProperties: { className: CUSTOM_EMOJI_CLASS, dataEmojiId: id },
        },
      });
    } else {
      onUnknown();
      parts.push({ type: "text", value: `:${name}:` });
    }
    lastIndex = index + match[0].length;
  }

  if (!found) {
    return null;
  }
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

/** A unified attacher, like `remarkMentions`. */
export function remarkCustomEmoji(
  isKnown: (id: string) => boolean,
  onUnknown: () => void = () => {},
) {
  return () => (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (!node.children || OPAQUE_PARENTS.has(node.type)) {
        return;
      }
      const next: MdastNode[] = [];
      let changed = false;
      for (const child of node.children) {
        if (child.type === "text" && !child.data) {
          const split = splitTextNode(child, isKnown, onUnknown);
          if (split) {
            next.push(...split);
            changed = true;
            continue;
          }
        }
        walk(child);
        next.push(child);
      }
      if (changed) {
        node.children = next;
      }
    }
    if (tree) {
      walk(tree);
    }
  };
}
