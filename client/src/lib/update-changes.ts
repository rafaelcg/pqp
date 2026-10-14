/**
 * "What's changed", for the update popover.
 *
 * `/changes.json` is written next to the build by the deploy
 * (`client/scripts/build-changes.mjs`, step "Write what changed" in
 * `.github/workflows/deploy-web.yml`) and accumulates: every deploy adds the
 * merged work that touched the web client since the previous deploy and keeps
 * the last two weeks, because a window that has been open for a week is told
 * about everything since ITS build, not only about the last deploy.
 *
 * WHAT A LINE IS. A pull request title is written for a reviewer, in English
 * ("Rail: read unread for every server on load"), and a person updating the app
 * is not one. So a line only exists when its author wrote one for the person
 * (an "Update note" line in the commit message, see the script) and it is shown
 * in the person's language or not at all. The rest are counted, never quoted:
 * "and 7 more small improvements" is honest and is not a wall of English in a
 * Portuguese popover. The link next to the list is the weekly notes (`/blog`,
 * the same files as What's New).
 *
 * Pure apart from `fetchChanges`; the file may be missing (an older deploy, a
 * self-host, a failed step) and then the popover simply has no list.
 */

export type ChangeLocale = "en" | "pt-BR" | "es";

export interface ChangeEntry {
  /** The pull request, for support; may be unknown. */
  pr: number | null;
  /** When it was merged, epoch milliseconds. */
  at: number;
  /** One short sentence per language, written for the person. Any may be missing. */
  note: Partial<Record<ChangeLocale, string>>;
}

/** The most lines the popover lists; the rest are counted. */
export const MAX_CHANGE_LINES = 4;
const MAX_NOTE_LENGTH = 140;

function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= MAX_NOTE_LENGTH ? text : null;
}

/** `/changes.json` as the deploy writes it, or an empty list for anything else. */
export function parseChanges(raw: unknown): ChangeEntry[] {
  const list = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) {
    return [];
  }
  const entries: ChangeEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const { pr, at, note } = item as {
      pr?: unknown;
      at?: unknown;
      note?: unknown;
    };
    if (typeof at !== "number" || !Number.isFinite(at)) {
      continue;
    }
    const notes: ChangeEntry["note"] = {};
    for (const locale of ["en", "pt-BR", "es"] as const) {
      const text = cleanNote((note as Record<string, unknown> | null)?.[locale]);
      if (text) {
        notes[locale] = text;
      }
    }
    entries.push({
      pr: typeof pr === "number" && Number.isFinite(pr) ? pr : null,
      at,
      note: notes,
    });
  }
  return entries;
}

export interface ChangeSummary {
  /** Sentences in the person's language, newest first, at most `MAX_CHANGE_LINES`. */
  lines: string[];
  /** Changes that have no sentence in this language, or no room: counted, not quoted. */
  more: number;
}

/**
 * What changed since `since` (the running bundle's build time) in `locale`.
 * Spanish falls back to nothing, not to English, for the same reason Portuguese
 * does: a line in the wrong language reads as an error.
 */
export function summarizeChanges(
  entries: ChangeEntry[],
  since: number,
  locale: ChangeLocale,
): ChangeSummary {
  const newer = entries
    .filter((entry) => entry.at > since)
    .sort((a, b) => b.at - a.at);
  const lines: string[] = [];
  for (const entry of newer) {
    const text = entry.note[locale];
    if (text && !lines.includes(text) && lines.length < MAX_CHANGE_LINES) {
      lines.push(text);
    }
  }
  return { lines, more: newer.length - lines.length };
}

export async function fetchChanges(
  fetchImpl: typeof fetch = fetch,
): Promise<ChangeEntry[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(`/changes.json?t=${Date.now()}`, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return [];
    }
    return parseChanges(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
