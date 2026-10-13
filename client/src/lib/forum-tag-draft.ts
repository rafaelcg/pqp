import {
  FORUM_MAX_TAGS,
  FORUM_TAG_NAME_MAX,
  FORUM_TAG_PRESET_ICON,
  forumTagIconEmoji,
  forumTagNameKey,
  type ForumTag,
  type ForumTagIconKey,
  type ForumTagPreset,
  type PutForumTagsRequest,
} from "@pqp/shared";
import type { MessageKey } from "@/lib/i18n";

/**
 * The Tags section of a forum's settings, as data: the rows being edited, the
 * "Exigir pelo menos uma tag" switch, how many changes are unsaved, whether
 * the draft can be saved and the one PUT that saves it.
 *
 * Pure so the rules the sticky footer states ("2 mudanças não salvas") and the
 * rules the server enforces (20 tags, 20 characters, no duplicate name) can be
 * tested without a dialog, and so the section component only draws.
 *
 * NAMES COMPARE THE WAY PEOPLE TYPE THEM. "Dúvida", "duvida" and " DÚVIDA "
 * are one tag to a reader scanning the filter row, so a draft holding two of
 * them is refused here with "Já tem uma tag com esse nome." before the server
 * is asked. The server's own check is case-insensitive only (see
 * `putForumTagsSchema`); this is stricter on purpose, never looser.
 */

export interface TagDraftRow {
  /** Stable React key: the tag id, or a local id for a row not saved yet. */
  key: string;
  /** Absent for a tag the PUT will create. */
  id?: string;
  /**
   * The name as STORED. A row with a `preset` is drawn in the viewer's
   * language instead (see `labelOf`), and keeps this until it is renamed.
   */
  name: string;
  /**
   * Legacy glyph. Never edited by hand any more: picking an icon writes the
   * icon's own emoji here so a phone build that predates icons still shows
   * something close, and clearing the icon clears it.
   */
  emoji: string | null;
  icon: ForumTagIconKey | null;
  /** Set while a starter tag has not been renamed; a rename clears it. */
  preset: ForumTagPreset | null;
  moderated: boolean;
  /** Posts carrying it; 0 for a new row. */
  postCount: number;
}

export interface TagDraft {
  rows: TagDraftRow[];
  requireTag: boolean;
}

export function draftFromServer(
  tags: readonly ForumTag[],
  requireTag: boolean,
): TagDraft {
  return {
    rows: [...tags]
      .sort((a, b) => a.position - b.position)
      .map((tag) => ({
        key: tag.id,
        id: tag.id,
        name: tag.name,
        emoji: tag.emoji,
        icon: tag.icon ?? null,
        preset: tag.preset ?? null,
        moderated: tag.moderated,
        postCount: tag.postCount,
      })),
    requireTag,
  };
}

/**
 * Case-, accent- and space-insensitive: what makes two names "the same tag".
 * The server's rule, so the screen and the PUT never disagree.
 */
export const tagNameKey = forumTagNameKey;

/** What the name field holds after a keystroke: one line, never past the cap. */
export function clampTagName(value: string): string {
  return Array.from(value.replace(/[\r\n\t]+/g, " "))
    .slice(0, FORUM_TAG_NAME_MAX)
    .join("");
}

let localKeySeq = 0;
function localKey(): string {
  localKeySeq += 1;
  return `new-${localKeySeq}`;
}

export type AddTagResult =
  | { ok: true; draft: TagDraft }
  | {
      ok: false;
      error: Extract<
        MessageKey,
        | "forum.settings.full"
        | "forum.settings.nameTaken"
        | "forum.settings.nameRequired"
      >;
    };

/** Add one row at the end, or say why not. */
export function addTag(
  draft: TagDraft,
  input: {
    name: string;
    icon?: ForumTagIconKey | null;
    preset?: ForumTagPreset | null;
    moderated?: boolean;
  },
  /** What each row is called on screen, so the check sees what a reader sees. */
  labelOf: (row: TagDraftRow) => string = (row) => row.name,
): AddTagResult {
  const name = clampTagName(input.name.replace(/\s+/g, " ").trim()).trim();
  if (!name) {
    return { ok: false, error: "forum.settings.nameRequired" };
  }
  if (draft.rows.length >= FORUM_MAX_TAGS) {
    return { ok: false, error: "forum.settings.full" };
  }
  const key = tagNameKey(name);
  if (
    draft.rows.some((row) => tagNameKey(row.name) === key || tagNameKey(labelOf(row)) === key)
  ) {
    return { ok: false, error: "forum.settings.nameTaken" };
  }
  return {
    ok: true,
    draft: {
      ...draft,
      rows: [
        ...draft.rows,
        {
          key: localKey(),
          name: clampTagName(name),
          emoji: input.icon ? forumTagIconEmoji(input.icon) : null,
          icon: input.icon ?? null,
          preset: input.preset ?? null,
          moderated: input.moderated ?? false,
          postCount: 0,
        },
      ],
    },
  };
}

export function updateTag(
  draft: TagDraft,
  key: string,
  patch: Partial<Pick<TagDraftRow, "name" | "icon" | "moderated">>,
): TagDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) => {
      if (row.key !== key) {
        return row;
      }
      const next = { ...row, ...patch };
      if (patch.name !== undefined) {
        next.name = clampTagName(patch.name);
        // The staff's own words from here on, in every language.
        next.preset = null;
      }
      if (patch.icon !== undefined) {
        // The emoji follows the icon (see `TagDraftRow.emoji`).
        next.emoji = patch.icon ? forumTagIconEmoji(patch.icon) : null;
      }
      return next;
    }),
  };
}

export function removeTag(draft: TagDraft, key: string): TagDraft {
  return { ...draft, rows: draft.rows.filter((row) => row.key !== key) };
}

/** Move a row by one (the handle's arrow keys) or to an index (a drop). */
export function moveTag(draft: TagDraft, key: string, toIndex: number): TagDraft {
  const from = draft.rows.findIndex((row) => row.key === key);
  if (from === -1) {
    return draft;
  }
  const to = Math.max(0, Math.min(draft.rows.length - 1, toIndex));
  if (to === from) {
    return draft;
  }
  const rows = [...draft.rows];
  const [moved] = rows.splice(from, 1);
  rows.splice(to, 0, moved!);
  return { ...draft, rows };
}

/**
 * How many things the footer counts as unsaved: each added, removed or edited
 * tag, one for the order when the surviving tags moved, and one for the
 * switch. What a person would list if asked "what did you change".
 */
export function unsavedChangeCount(baseline: TagDraft, draft: TagDraft): number {
  let count = 0;
  const before = new Map(baseline.rows.map((row) => [row.key, row]));
  const after = new Map(draft.rows.map((row) => [row.key, row]));
  for (const row of draft.rows) {
    const old = before.get(row.key);
    if (!old) {
      count += 1;
    } else if (
      old.name.trim() !== row.name.trim() ||
      old.icon !== row.icon ||
      // Typing the stored name over a translated starter changes nothing
      // else, and is still a change: everybody now reads that wording.
      old.preset !== row.preset ||
      old.moderated !== row.moderated
    ) {
      count += 1;
    }
  }
  for (const row of baseline.rows) {
    if (!after.has(row.key)) {
      count += 1;
    }
  }
  const keptBefore = baseline.rows.filter((row) => after.has(row.key)).map((row) => row.key);
  const keptAfter = draft.rows.filter((row) => before.has(row.key)).map((row) => row.key);
  if (keptBefore.join("\u0000") !== keptAfter.join("\u0000")) {
    count += 1;
  }
  if (baseline.requireTag !== draft.requireTag) {
    count += 1;
  }
  return count;
}

export function tagsChanged(baseline: TagDraft, draft: TagDraft): boolean {
  return unsavedChangeCount({ ...baseline, requireTag: draft.requireTag }, draft) > 0;
}

/** The first problem that would make the server refuse the PUT, by row. */
export function draftProblems(
  draft: TagDraft,
  /** What each row is called on screen; a starter shows in the viewer's language. */
  labelOf: (row: TagDraftRow) => string = (row) => row.name,
): Map<string, Extract<MessageKey, "forum.settings.nameTaken" | "forum.settings.nameRequired">> {
  const problems = new Map<
    string,
    Extract<MessageKey, "forum.settings.nameTaken" | "forum.settings.nameRequired">
  >();
  const seen = new Set<string>();
  for (const row of draft.rows) {
    // Both the stored name (what the server's uniqueness rule reads) and the
    // one drawn on screen (what a reader would take for a twin).
    const keys = new Set([tagNameKey(row.name), tagNameKey(labelOf(row))]);
    if (!tagNameKey(row.name)) {
      problems.set(row.key, "forum.settings.nameRequired");
    } else if ([...keys].some((key) => seen.has(key))) {
      problems.set(row.key, "forum.settings.nameTaken");
    }
    for (const key of keys) {
      seen.add(key);
    }
  }
  return problems;
}

export function toPutBody(draft: TagDraft): PutForumTagsRequest {
  return {
    tags: draft.rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      name: row.name.replace(/\s+/g, " ").trim(),
      emoji: row.emoji,
      icon: row.icon,
      preset: row.preset,
      moderated: row.moderated,
    })),
  };
}

// --------------------------------------------------------------- starters

export interface StarterTag {
  preset: ForumTagPreset;
  icon: ForumTagIconKey;
  nameKey: Extract<
    MessageKey,
    | "forum.tags.preset.question"
    | "forum.tags.preset.bug"
    | "forum.tags.preset.suggestion"
    | "forum.tags.preset.tutorial"
    | "forum.tags.preset.release"
    | "forum.tags.preset.wip"
    | "forum.tags.preset.discussion"
  >;
}

function starter(
  preset: ForumTagPreset,
  nameKey: StarterTag["nameKey"],
): StarterTag {
  return { preset, icon: FORUM_TAG_PRESET_ICON[preset], nameKey };
}

const SUPPORT_KIT: StarterTag[] = [
  starter("question", "forum.tags.preset.question"),
  starter("bug", "forum.tags.preset.bug"),
  starter("suggestion", "forum.tags.preset.suggestion"),
  starter("tutorial", "forum.tags.preset.tutorial"),
];

const SHOWCASE_KIT: StarterTag[] = [
  starter("release", "forum.tags.preset.release"),
  starter("wip", "forum.tags.preset.wip"),
  starter("discussion", "forum.tags.preset.discussion"),
  starter("question", "forum.tags.preset.question"),
];

/** Channel names that read as a help desk, accents and case folded. */
const SUPPORT_NAMES = [
  "ajuda",
  "suporte",
  "help",
  "support",
  "duvida",
  "duvidas",
  "bug",
  "bugs",
  "ayuda",
  "soporte",
  "faq",
];

/**
 * The four chips a forum with no tags is offered. A help desk gets Dúvida,
 * Bug, Sugestão, Tutorial; anything else (a showcase, a news board) gets
 * Lançamento, WIP, Discussão, Dúvida, so a "mostra o teu projeto" forum does
 * not start life with a Bug tag.
 */
export function starterTagsFor(channelName: string): StarterTag[] {
  const words = tagNameKey(channelName).split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((word) => SUPPORT_NAMES.includes(word)) ? SUPPORT_KIT : SHOWCASE_KIT;
}

/**
 * Put the starter tags in the draft (skipping any name already there). The
 * name is stored in the language the staff member has right now and the
 * `preset` is what lets every other reader see their own language's word.
 */
export function addStarterTags(
  draft: TagDraft,
  starters: readonly { name: string; preset: ForumTagPreset; icon: ForumTagIconKey }[],
  labelOf?: (row: TagDraftRow) => string,
): TagDraft {
  let next = draft;
  for (const one of starters) {
    const result = addTag(
      next,
      { name: one.name, icon: one.icon, preset: one.preset },
      labelOf,
    );
    if (result.ok) {
      next = result.draft;
    }
  }
  return next;
}
