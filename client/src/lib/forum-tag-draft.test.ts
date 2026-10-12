import { describe, expect, it } from "vitest";
import { FORUM_MAX_TAGS, forumTagIconEmoji, putForumTagsSchema, type ForumTag } from "@pqp/shared";
import {
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

const tag = (
  id: string,
  name: string,
  position: number,
  postCount = 0,
  extra: Partial<ForumTag> = {},
): ForumTag => ({
  id,
  name,
  emoji: null,
  icon: null,
  preset: null,
  ...extra,
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
    const added = addTag(base, { name: "  Games  ", icon: "game", moderated: true });
    if (!added.ok) {
      throw new Error(added.error);
    }
    const body = toPutBody(added.draft);
    expect(body).toEqual({
      tags: [
        { id: ID.bug, name: "Bug", emoji: null, icon: null, preset: null, moderated: false },
        { id: ID.duvida, name: "Dúvida", emoji: null, icon: null, preset: null, moderated: false },
        // The icon's own emoji rides along for phone builds that predate icons.
        { name: "Games", emoji: "🎮", icon: "game", preset: null, moderated: true },
      ],
    });
    // And the shared contract accepts it as is.
    expect(putForumTagsSchema.safeParse(body).success).toBe(true);
  });
});

describe("icons and presets", () => {
  const withPreset = [
    tag(ID.bug, "Bug", 0, 4, { icon: "bug", emoji: "🐛", preset: "bug" }),
    tag(ID.duvida, "Question", 1, 9, { icon: "question", emoji: "❓", preset: "question" }),
  ];
  // What a Brazilian reader sees for a preset stored in English.
  const labelOf = (row: { name: string; preset: string | null }) =>
    row.preset === "question" ? "Dúvida" : row.name;

  it("carries icon and preset from the server, and tolerates an older server's tag", () => {
    const draft = draftFromServer(withPreset, false);
    expect(draft.rows.map((row) => [row.icon, row.preset])).toEqual([
      ["bug", "bug"],
      ["question", "question"],
    ]);
    const old = draftFromServer(
      [{ id: ID.games, name: "Games", emoji: "🎮", moderated: false, position: 0, postCount: 0 }],
      false,
    );
    expect(old.rows[0]).toMatchObject({ icon: null, preset: null, emoji: "🎮" });
  });

  it("picking an icon writes its emoji beside it; clearing it clears both", () => {
    const base = draftFromServer(server, false);
    const picked = updateTag(base, ID.bug, { icon: "idea" });
    expect(picked.rows.find((row) => row.key === ID.bug)).toMatchObject({
      icon: "idea",
      emoji: forumTagIconEmoji("idea"),
    });
    expect(unsavedChangeCount(base, picked)).toBe(1);
    const cleared = updateTag(picked, ID.bug, { icon: null });
    expect(cleared.rows.find((row) => row.key === ID.bug)).toMatchObject({
      icon: null,
      emoji: null,
    });
    expect(unsavedChangeCount(base, cleared)).toBe(0);
  });

  it("renaming a starter ends the localization, and only a rename does", () => {
    const base = draftFromServer(withPreset, false);
    expect(updateTag(base, ID.duvida, { moderated: true }).rows[1]!.preset).toBe("question");
    expect(updateTag(base, ID.duvida, { icon: "help" }).rows[1]!.preset).toBe("question");
    const renamed = updateTag(base, ID.duvida, { name: "Pergunta" });
    expect(renamed.rows[1]).toMatchObject({ name: "Pergunta", preset: null });
    expect(unsavedChangeCount(base, renamed)).toBe(1);
  });

  it("sends the preset on, so a new starter is created localizable", () => {
    const body = toPutBody(draftFromServer(withPreset, false));
    expect(body.tags[1]).toMatchObject({ name: "Question", preset: "question", icon: "question" });
    expect(putForumTagsSchema.safeParse(body).success).toBe(true);
  });

  it("twin names are judged by what a reader sees as well as what is stored", () => {
    const base = draftFromServer(withPreset, false);
    // "Dúvida" is what the starter shows; typing it as a new tag is a twin.
    expect(addTag(base, { name: "duvida" }, labelOf)).toEqual({
      ok: false,
      error: "forum.settings.nameTaken",
    });
    // And the stored name still counts, or the server would refuse the save.
    expect(addTag(base, { name: "Question" }, labelOf)).toEqual({
      ok: false,
      error: "forum.settings.nameTaken",
    });
    const renamedToTwin = updateTag(base, ID.bug, { name: "Dúvida" });
    expect(draftProblems(renamedToTwin, labelOf).get(ID.duvida)).toBe("forum.settings.nameTaken");
    expect(draftProblems(base, labelOf).size).toBe(0);
  });
});

describe("starter tags", () => {
  it("gives a help desk the support kit and anything else the showcase kit", () => {
    expect(starterTagsFor("ajuda").map((one) => one.nameKey)).toEqual([
      "forum.tags.preset.question",
      "forum.tags.preset.bug",
      "forum.tags.preset.suggestion",
      "forum.tags.preset.tutorial",
    ]);
    expect(starterTagsFor("Dúvidas-gerais")[1]!.nameKey).toBe("forum.tags.preset.bug");
    expect(starterTagsFor("showcase").map((one) => one.nameKey)).toEqual([
      "forum.tags.preset.release",
      "forum.tags.preset.wip",
      "forum.tags.preset.discussion",
      "forum.tags.preset.question",
    ]);
  });

  it("every starter names a preset and an icon, and the kits repeat neither", () => {
    for (const channel of ["ajuda", "showcase"]) {
      const kit = starterTagsFor(channel);
      expect(new Set(kit.map((one) => one.preset)).size).toBe(kit.length);
      for (const one of kit) {
        expect(one.nameKey).toBe(`forum.tags.preset.${one.preset}`);
        expect(one.icon).toBeTruthy();
      }
    }
  });

  it("adds the kit in one go with preset and icon, skipping a name already there", () => {
    const base = draftFromServer([tag(ID.bug, "Bug", 0)], false);
    const next = addStarterTags(base, [
      { name: "Dúvida", preset: "question", icon: "question" },
      { name: "bug", preset: "bug", icon: "bug" },
      { name: "Sugestão", preset: "suggestion", icon: "idea" },
    ]);
    expect(next.rows.map((row) => [row.name, row.preset, row.icon])).toEqual([
      ["Bug", null, null],
      ["Dúvida", "question", "question"],
      ["Sugestão", "suggestion", "idea"],
    ]);
  });
});
