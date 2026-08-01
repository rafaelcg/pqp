import { MENTION_PATTERN } from "@pqp/shared";

/**
 * Highlights `@username` inside rendered markdown.
 *
 * Doing this as a remark plugin rather than by splitting the raw string keeps
 * markdown working around it — a mention next to `**bold**` or inside a list
 * still renders as markdown, and mentions inside code spans are left alone
 * because those are not `text` nodes.
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

/** Node types whose text content must stay literal. */
const OPAQUE_PARENTS = new Set(["link", "linkReference", "definition"]);

function splitTextNode(
  node: MdastNode,
  currentUsername: string | null,
): MdastNode[] | null {
  const value = node.value ?? "";
  const pattern = new RegExp(MENTION_PATTERN);
  const parts: MdastNode[] = [];
  let lastIndex = 0;
  let found = false;

  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    found = true;
    if (index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, index) });
    }
    const username = (match[1] ?? "").toLowerCase();
    parts.push({
      type: "text",
      value: match[0],
      data: {
        hName: "span",
        hProperties: {
          className:
            username === currentUsername
              ? "pqp-mention pqp-mention-self"
              : "pqp-mention",
        },
      },
    });
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

/**
 * Returns a unified *attacher* (a plugin), not a transformer — unified calls the
 * value in `remarkPlugins` with the plugin options and uses what it returns to
 * process the tree.
 */
export function remarkMentions(currentUsername: string | null) {
  const me = currentUsername?.toLowerCase() ?? null;

  return () => (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (!node.children || OPAQUE_PARENTS.has(node.type)) {
        return;
      }

      const next: MdastNode[] = [];
      let changed = false;

      for (const child of node.children) {
        if (child.type === "text") {
          const split = splitTextNode(child, me);
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
