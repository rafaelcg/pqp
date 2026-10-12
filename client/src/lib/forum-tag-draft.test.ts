import { describe, expect, it } from "vitest";
import { FORUM_MAX_TAGS, putForumTagsSchema, type ForumTag } from "@pqp/shared";
import {
  acceptTagEmoji,
  addStarterTags,
  addTag,
  clampTagName,
  draftFromServer,
  draftProblems,
  moveTag,
  removeTag,
  starterTagsFor,
  tagNameKey,
  tagsChanged,
  toPutBody,
  unsavedChangeCount,
  updateTag,
} from "./forum-tag-draft";

const tag = (id: string, name: string, position: number, postCount = 0): ForumTag => ({
  id,
  name,
  emoji: null,
  moderated: false,
  position,
  postCount,
});

const ID = {
  bug: "11111111-1111-4111-8111-111111111111",
  duvida: "22222222-2222-4222-8222-222222222222",
  games: "33333333-3333-4333-8333-333333333333",
};

const server = [tag(ID.duvida, "Dúvida", 1, 128), tag(ID.bug, "Bug", 0, 64)];

describe("draftFromServer", () => {
  it("orders by position and keeps the post counts", () => {
    const draft = draftFromServer(server, true);
    expect(draft.rows.map((row) => row.name)).toEqual(["Bug", "Dúvida"]);
    expect(draft.rows[0]!.postCount).toBe(64);
    expect(draft.requireTag).toBe(true);
  });
});

describe("tag names", () => {
  it("compares the way a reader does: case, accents and spaces folded", () => {
    expect(tagNameKey(" DÚVIDA ")).toBe(tagNameKey("duvida"));
    expect(tagNameKey("Sugestão")).toBe("sugestao");
  });

  it("refuses a duplicate, an empty name and a 21st tag", () => {
    const base = draftFromServer(server, false);
    expect(addTag(base, { name: "duvida" })).toEqual({
      ok: false,
      error: "forum.settings.nameTaken",
    });
    expect(addTag(base, { name: "   " })).toEqual({
      ok: false,
      error: "forum.settings.nameRequired",
    });
    let full = base;
    for (let index = full.rows.length; index < FORUM_MAX_TAGS; index += 1) {
      const result = addTag(full, { name: `Tag ${index}` });
      if (!result.ok) {
        throw new Error(result.error);
      }
      full = result.draft;
    }
    expect(full.rows).toHaveLength(FORUM_MAX_TAGS);
    expect(addTag(full, { name: "Mais uma" })).toEqual({
      ok: false,
      error: "forum.settings.full",
    });
  });

  it("clamps a typed name at 20 characters without splitting an emoji", () => {
    expect(clampTagName("a".repeat(30))).toHaveLength(20);
    expect(Array.from(clampTagName(`${"a".repeat(19)}🎮🎮`))).toHaveLength(20);
  });

  it("takes a unicode emoji and nothing else", () => {
    expect(acceptTagEmoji("🐛")).toBe("🐛");
    expect(acceptTagEmoji("🛠️")).toBe("🛠️");
    expect(acceptTagEmoji("1️⃣")).toBe("1️⃣");
    expect(acceptTagEmoji("🇧🇷")).toBe("🇧🇷");
    expect(acceptTagEmoji(":pepe:")).toBeNull();
    expect(acceptTagEmoji("abc")).toBeNull();
    expect(acceptTagEmoji("?!")).toBeNull();
    expect(acceptTagEmoji("a🐛")).toBeNull();
    expect(acceptTagEmoji("🐛 bug")).toBeNull();
    expect(acceptTagEmoji("👨‍💻")).toBe("👨‍💻");
    expect(acceptTagEmoji("")).toBeNull();
  });
});

describe("unsavedChangeCount", () => {
  const baseline = draftFromServer(server, false);

  it("is zero for an untouched draft", () => {
    expect(unsavedChangeCount(baseline, baseline)).toBe(0);
  });

  it("counts an added, a renamed and a removed tag once each", () => {
    const added = addTag(baseline, { name: "Games" });
    if (!added.ok) {
      throw new Error(added.error);
    }
    let draft = updateTag(added.draft, ID.bug, { name: "Bugs" });
    draft = removeTag(draft, ID.duvida);
    expect(unsavedChangeCount(baseline, draft)).toBe(3);
  });

  it("counts a new order once, and the switch once", () => {
    const moved = moveTag(baseline, ID.duvida, 0);
    expect(unsavedChangeCount(baseline, moved)).toBe(1);
    expect(unsavedChangeCount(baseline, { ...moved, requireTag: true })).toBe(2);
    expect(tagsChanged(baseline, { ...baseline, requireTag: true })).toBe(false);
    expect(tagsChanged(baseline, moved)).toBe(true);
  });

  it("does not count a rename that only added a trailing space", () => {
    const draft = updateTag(baseline, ID.bug, { name: "Bug " });
    expect(unsavedChangeCount(baseline, draft)).toBe(0);
  });

  it("goes back to zero when a change is undone by hand", () => {
    const there = moveTag(baseline, ID.duvida, 0);
    const back = moveTag(there, ID.duvida, 1);
    expect(unsavedChangeCount(baseline, back)).toBe(0);
  });
});

describe("draftProblems", () => {
  it("names the row that would be refused", () => {
    const base = draftFromServer(server, false);
    const renamed = updateTag(base, ID.bug, { name: "dúvida" });
    expect(draftProblems(renamed).get(ID.duvida)).toBe("forum.settings.nameTaken");
    const blank = updateTag(base, ID.bug, { name: "  " });
    expect(draftProblems(blank).get(ID.bug)).toBe("forum.settings.nameRequired");
  });
});

describe("toPutBody", () => {
  it("is the whole list in order, ids kept for edits and absent for new tags", () => {
    const base = draftFromServer(server, false);
    const added = addTag(base, { name: "  Games  ", emoji: "🎮", moderated: true });
    if (!added.ok) {
      throw new Error(added.error);
    }
    const body = toPutBody(added.draft);
    expect(body).toEqual({
      tags: [
        { id: ID.bug, name: "Bug", emoji: null, moderated: false },
        { id: ID.duvida, name: "Dúvida", emoji: null, moderated: false },
        { name: "Games", emoji: "🎮", moderated: true },
      ],
    });
    // And the shared contract accepts it as is.
    expect(putForumTagsSchema.safeParse(body).success).toBe(true);
  });
});

describe("starter tags", () => {
  it("gives a help desk the support kit and anything else the showcase kit", () => {
    expect(starterTagsFor("ajuda").map((one) => one.nameKey)).toEqual([
      "forum.starter.question",
      "forum.starter.bug",
      "forum.starter.suggestion",
      "forum.starter.tutorial",
    ]);
    expect(starterTagsFor("Dúvidas-gerais")[1]!.nameKey).toBe("forum.starter.bug");
    expect(starterTagsFor("showcase").map((one) => one.nameKey)).toEqual([
      "forum.starter.release",
      "forum.starter.wip",
      "forum.starter.discussion",
      "forum.starter.question",
    ]);
  });

  it("adds the four in one go and skips a name already there", () => {
    const base = draftFromServer([tag(ID.bug, "Bug", 0)], false);
    const next = addStarterTags(base, [
      { name: "Dúvida", emoji: "❓" },
      { name: "bug", emoji: "🐛" },
      { name: "Sugestão", emoji: "💡" },
    ]);
    expect(next.rows.map((row) => row.name)).toEqual(["Bug", "Dúvida", "Sugestão"]);
  });
});
