/**
 * Chat keeps Shift+Enter as a real line break, and one blank line as a
 * paragraph. Runs of empty lines after that are how people shove the next
 * message off the screen, and Slack / Discord do not stop that beyond the
 * character cap. One blank line is enough; the rest is collapsed.
 *
 * Fenced code is left alone so a pasted snippet with gaps stays a snippet.
 */

const FENCE_LINE = /^( {0,3})(```+|~~~+)(.*)$/;

function isBlankLine(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/**
 * Collapse 3+ consecutive newlines to 2, drop leading and trailing blank
 * lines, and leave fenced blocks untouched. Idempotent.
 */
export function clampChatNewlines(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let started = false;
  let pendingBlank = false;

  for (const line of lines) {
    const fence = FENCE_LINE.exec(line);
    let isFenceMarker = false;
    if (fence) {
      const marker = fence[2]!;
      const char = marker[0]!;
      const len = marker.length;
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLen = len;
        isFenceMarker = true;
      } else if (
        char === fenceChar &&
        len >= fenceLen &&
        fence[3]!.trim() === ""
      ) {
        inFence = false;
        isFenceMarker = true;
      }
    }

    if ((inFence && !isFenceMarker) || isFenceMarker) {
      if (started && pendingBlank) {
        out.push("");
        pendingBlank = false;
      }
      out.push(line);
      started = true;
      continue;
    }

    if (isBlankLine(line)) {
      if (started) {
        pendingBlank = true;
      }
      continue;
    }

    if (started && pendingBlank) {
      out.push("");
      pendingBlank = false;
    }
    out.push(line);
    started = true;
  }

  return out.join("\n");
}
