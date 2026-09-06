/**
 * `Accept: text/markdown` for the pages that have a markdown twin.
 *
 * WHY. An agent fetching this site gets a static SPA shell: a div and a script
 * tag. It can execute the script, or it can be handed the same page as prose.
 * Content negotiation is the standard way to offer the second without changing
 * what a browser sees, and it costs one branch at the edge because the markdown
 * is a checked-in file, not a rendering of the React tree.
 *
 * DELIBERATELY ONE PAGE. Only `/` has a twin (`/index.md`). A markdown variant
 * that is stale or invented is worse than none, so a page gets one when
 * somebody writes it, not because the route exists. `/llms.txt` and
 * `/llms-full.txt` already carry the rest.
 *
 * The parsing is quality-aware because the header that matters in practice is
 * the browser's, and a browser sends `text/html,...,*\/*;q=0.8`. A `*\/*`
 * wildcard must NOT win markdown: that is every browser on earth. Only an
 * explicit `text/markdown` (or `text/*`) that outranks `text/html` does.
 */

/** The markdown twin of a path, or null if it has none. */
export function markdownTwinFor(pathname: string): string | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === "/" ? "/index.md" : null;
}

interface AcceptEntry {
  type: string;
  q: number;
  /** Position in the header, to keep equal-q comparisons stable. */
  order: number;
}

function parseAccept(header: string): AcceptEntry[] {
  return header
    .split(",")
    .map((part, order) => {
      const [rawType, ...params] = part.split(";");
      const type = rawType.trim().toLowerCase();
      if (!type) {
        return null;
      }
      let q = 1;
      for (const param of params) {
        const [key, value] = param.split("=");
        if (key?.trim().toLowerCase() === "q") {
          const parsed = Number.parseFloat(value ?? "");
          // A malformed q is treated as absent rather than as zero: refusing a
          // page because a header was typed badly is the wrong failure.
          if (Number.isFinite(parsed)) {
            q = Math.min(Math.max(parsed, 0), 1);
          }
        }
      }
      return { type, q, order };
    })
    .filter((entry): entry is AcceptEntry => entry !== null);
}

function scoreFor(entries: AcceptEntry[], candidates: string[]): AcceptEntry | null {
  let best: AcceptEntry | null = null;
  for (const entry of entries) {
    if (!candidates.includes(entry.type) || entry.q === 0) {
      continue;
    }
    if (!best || entry.q > best.q || (entry.q === best.q && entry.order < best.order)) {
      best = entry;
    }
  }
  return best;
}

/**
 * Whether this `Accept` header asks for markdown in preference to HTML.
 *
 * `text/*` counts as a markdown ask only because the same wildcard would also
 * satisfy HTML, so it can never demote a browser: a browser that sends `text/*`
 * also sends `text/html` explicitly, which ties and wins on order.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) {
    return false;
  }
  const entries = parseAccept(accept);
  const markdown = scoreFor(entries, ["text/markdown", "text/x-markdown", "text/*"]);
  if (!markdown) {
    return false;
  }
  const html = scoreFor(entries, ["text/html", "application/xhtml+xml"]);
  if (!html) {
    return true;
  }
  return markdown.q > html.q;
}
