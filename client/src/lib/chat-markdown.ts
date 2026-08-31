/**
 * Chat markdown is Discord-shaped, not CommonMark-shaped.
 *
 * The composer is a textarea: Shift+Enter (and the phone Return key) inserts a
 * real newline, extra spaces stay visible, and `# topic` is just text. CommonMark
 * folds a single newline into a space, squeezes blank lines into a paragraph
 * gap, and eats `#` as a heading. The iOS client already parses inline markup
 * while keeping whitespace; this is the web equivalent.
 */

import { clampChatNewlines } from "@pqp/shared";

/** Placed on otherwise-blank lines so the parser cannot treat them as breaks. */
export const CHAT_NEWLINE_FILLER = "\u200B";

const FENCE_LINE = /^( {0,3})(```+|~~~+)(.*)$/;

/**
 * Keep every newline the author meant. Extra blank lines are already collapsed
 * by `clampChatNewlines` (one paragraph gap, not a wall of empty space). Empty
 * lines that remain become a filler character; `remark-breaks` then turns each
 * `\n` into a `<br>`, and a later plugin strips the filler so a blank line in
 * the composer is a blank line in the bubble. Fenced code is left alone so an
 * empty line inside a ``` block stays part of the code.
 */
export function prepareChatMarkdown(source: string): string {
  const normalized = clampChatNewlines(source);
  const lines = normalized.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  return lines
    .map((line) => {
      const fence = FENCE_LINE.exec(line);
      if (fence) {
        const marker = fence[2]!;
        const char = marker[0]!;
        const len = marker.length;
        if (!inFence) {
          inFence = true;
          fenceChar = char;
          fenceLen = len;
          return line;
        }
        if (char === fenceChar && len >= fenceLen && fence[3]!.trim() === "") {
          inFence = false;
          return line;
        }
      }
      if (!inFence && /^[ \t]*$/.test(line)) {
        return CHAT_NEWLINE_FILLER;
      }
      return line;
    })
    .join("\n");
}

/**
 * Headings, indented code, HTML and `---` rules stay literal. Chat does not
 * have a heading style, and `# announcement` losing its hash reads as a bug.
 * Lists, quotes and fenced code stay: those are typed on purpose.
 */
export function remarkDisableChatBlocks(this: {
  data: () => {
    micromarkExtensions?: Array<{ disable?: { null?: string[] } }>;
  };
}) {
  const data = this.data();
  const extensions = data.micromarkExtensions ?? [];
  extensions.push({
    disable: {
      null: [
        "headingAtx",
        "setextUnderline",
        "codeIndented",
        "htmlFlow",
        "htmlText",
        "thematicBreak",
      ],
    },
  });
  data.micromarkExtensions = extensions;
}

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/** Drop the filler so copy/paste does not carry a zero-width character. */
export function remarkStripNewlineFillers() {
  return (tree: MdastNode) => {
    function walk(node: MdastNode) {
      if (!node.children) {
        return;
      }
      node.children = node.children.filter((child) => {
        walk(child);
        return !(child.type === "text" && child.value === CHAT_NEWLINE_FILLER);
      });
    }
    walk(tree);
  };
}
