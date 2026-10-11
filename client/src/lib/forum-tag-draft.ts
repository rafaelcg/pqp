import {
  FORUM_MAX_TAGS,
  FORUM_TAG_EMOJI_MAX,
  FORUM_TAG_NAME_MAX,
  type ForumTag,
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
  name: string;
  emoji: string | null;
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
        moderated: tag.moderated,
        postCount: tag.postCount,
      })),
    requireTag,
  };
}

/** Case-, accent- and space-insensitive: what makes two names "the same tag". */
export function tagNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/** What the name field holds after a keystroke: one line, never past the cap. */
export function clampTagName(value: string): string {
  return Array.from(value.replace(/[\r\n\t]+/g, " "))
    .slice(0, FORUM_TAG_NAME_MAX)
    .join("");
}

/**
 * Only a unicode emoji fits a tag. The picker can also hand back a server's
 * custom emoji (`:name:`), which a tag cannot store, and anything past the
 * stored length is not one emoji.
 */
export function acceptTagEmoji(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith(":") || /[a-z0-9]/i.test(trimmed)) {
    return null;
  }
  return trimmed.length <= FORUM_TAG_EMOJI_MAX ? trimmed : null;
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
  input: { name: string; emoji?: string | null; moderated?: boolean },
): AddTagResult {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) {
    return { ok: false, error: "forum.settings.nameRequired" };
  }
  if (draft.rows.length >= FORUM_MAX_TAGS) {
    return { ok: false, error: "forum.settings.full" };
  }
  const key = tagNameKey(name);
  if (draft.rows.some((row) => tagNameKey(row.name) === key)) {
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
          emoji: input.emoji ?? null,
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
  patch: Partial<Pick<TagDraftRow, "name" | "emoji" | "moderated">>,
): TagDraft {
  return {
    ...draft,
    rows: draft.rows.map((row) =>
      row.key === key
        ? {
            ...row,
            ...patch,
            ...(patch.name !== undefined ? { name: clampTagName(patch.name) } : {}),
          }
        : row,
    ),
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
      old.emoji !== row.emoji ||
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
): Map<string, Extract<MessageKey, "forum.settings.nameTaken" | "forum.settings.nameRequired">> {
  const problems = new Map<
    string,
    Extract<MessageKey, "forum.settings.nameTaken" | "forum.settings.nameRequired">
  >();
  const seen = new Set<string>();
  for (const row of draft.rows) {
    const key = tagNameKey(row.name);
    if (!key) {
      problems.set(row.key, "forum.settings.nameRequired");
    } else if (seen.has(key)) {
      problems.set(row.key, "forum.settings.nameTaken");
    }
    seen.add(key);
  }
  return problems;
}

export function toPutBody(draft: TagDraft): PutForumTagsRequest {
  return {
    tags: draft.rows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      name: row.name.replace(/\s+/g, " ").trim(),
      emoji: row.emoji,
      moderated: row.moderated,
    })),
  };
}

// --------------------------------------------------------------- starters

export interface StarterTag {
  emoji: string;
  nameKey: Extract<
    MessageKey,
    | "forum.starter.question"
    | "forum.starter.bug"
    | "forum.starter.suggestion"
    | "forum.starter.tutorial"
    | "forum.starter.release"
    | "forum.starter.wip"
    | "forum.starter.discussion"
  >;
}

const SUPPORT_KIT: StarterTag[] = [
  { emoji: "❓", nameKey: "forum.starter.question" },
  { emoji: "🐛", nameKey: "forum.starter.bug" },
  { emoji: "💡", nameKey: "forum.starter.suggestion" },
  { emoji: "📚", nameKey: "forum.starter.tutorial" },
];

const SHOWCASE_KIT: StarterTag[] = [
  { emoji: "🚀", nameKey: "forum.starter.release" },
  { emoji: "🛠️", nameKey: "forum.starter.wip" },
  { emoji: "💬", nameKey: "forum.starter.discussion" },
  { emoji: "❓", nameKey: "forum.starter.question" },
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

/** Put the starter tags in the draft (skipping any name already there). */
export function addStarterTags(
  draft: TagDraft,
  starters: readonly { name: string; emoji: string }[],
): TagDraft {
  let next = draft;
  for (const starter of starters) {
    const result = addTag(next, { name: starter.name, emoji: starter.emoji });
    if (result.ok) {
      next = result.draft;
    }
  }
  return next;
}
