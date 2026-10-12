import { describe, expect, it } from "vitest";
import {
  bindingsEqual,
  channelIsUnread,
  defaultShortcutBindings,
  findBindingConflict,
  FORUM_KEY_ROWS,
  forumKeyAction,
  type ForumKeyEventLike,
  matchShortcut,
  navigableChannelIds,
  parseShortcutOverrides,
  resolveShortcutBindings,
  stepChannelId,
  stepUnreadChannelId,
} from "./keyboard-shortcuts";
import {
  defaultPushToTalkBinding as pttDefault,
  type KeyBinding,
  type KeyEventLike,
} from "@/components/voice/push-to-talk";

function keyEvent(
  partial: Partial<KeyEventLike> & { code: string },
): KeyEventLike {
  return {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  };
}

const composer = { tagName: "TEXTAREA" };
const plainDiv = { tagName: "DIV" };

const MAC = defaultShortcutBindings(true);
const WIN = defaultShortcutBindings(false);

describe("defaults", () => {
  it("uses Cmd on Apple and Ctrl elsewhere for mute, deafen, settings and the map", () => {
    expect(MAC.toggleMute).toMatchObject({
      code: "KeyM",
      meta: true,
      ctrl: false,
      shift: true,
    });
    expect(WIN.toggleMute).toMatchObject({
      code: "KeyM",
      meta: false,
      ctrl: true,
      shift: true,
    });
    expect(MAC.toggleOverlay).toMatchObject({
      code: "Slash",
      meta: true,
      shift: false,
    });
    expect(WIN.openUserSettings).toMatchObject({
      code: "Comma",
      ctrl: true,
      meta: false,
    });
  });

  it("binds openNewDm to Shift+N, not Shift+M — that chord is already toggleMute", () => {
    // The spec this ships against asked for Cmd/Ctrl+Shift+M, but that chord
    // was already `toggleMute` (and Electron's own app-menu accelerator), so
    // a second action on the same default chord would never fire: `matchShortcut`
    // only ever returns the first match, `toggleMute`. Shift+N is the fix.
    expect(MAC.openNewDm).toMatchObject({
      code: "KeyN",
      meta: true,
      ctrl: false,
      shift: true,
    });
    expect(WIN.openNewDm).toMatchObject({
      code: "KeyN",
      meta: false,
      ctrl: true,
      shift: true,
    });
    expect(findBindingConflict(MAC, "openNewDm", MAC.openNewDm)).toBeNull();
    expect(bindingsEqual(MAC.openNewDm, MAC.toggleMute)).toBe(false);
  });

  it("uses Alt arrows for channel motion, Shift for unread", () => {
    expect(MAC.previousChannel).toMatchObject({
      code: "ArrowUp",
      alt: true,
      shift: false,
    });
    expect(MAC.previousUnreadChannel).toMatchObject({
      code: "ArrowUp",
      alt: true,
      shift: true,
    });
  });
});

describe("match event → action", () => {
  it("maps the Discord mute chord", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          metaKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        MAC,
      ),
    ).toBe("toggleMute");
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        WIN,
      ),
    ).toBe("toggleMute");
  });

  it("maps deafen, settings, the overlay and channel motion", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        WIN,
      ),
    ).toBe("toggleDeafen");
    expect(
      matchShortcut(
        keyEvent({ code: "Comma", metaKey: true, target: plainDiv }),
        MAC,
      ),
    ).toBe("openUserSettings");
    expect(
      matchShortcut(
        keyEvent({ code: "Slash", ctrlKey: true, target: plainDiv }),
        WIN,
      ),
    ).toBe("toggleOverlay");
    expect(
      matchShortcut(
        keyEvent({ code: "ArrowDown", altKey: true, target: plainDiv }),
        MAC,
      ),
    ).toBe("nextChannel");
    expect(
      matchShortcut(
        keyEvent({
          code: "ArrowUp",
          altKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        MAC,
      ),
    ).toBe("previousUnreadChannel");
  });

  it("does not confuse Alt+↑ with Alt+Shift+↑", () => {
    expect(
      matchShortcut(
        keyEvent({ code: "ArrowUp", altKey: true, target: plainDiv }),
        WIN,
      ),
    ).toBe("previousChannel");
    expect(
      matchShortcut(
        keyEvent({
          code: "ArrowUp",
          altKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        WIN,
      ),
    ).toBe("previousUnreadChannel");
  });

  it("follows a remapped binding, not the leftover default", () => {
    const remapped = resolveShortcutBindings(
      {
        toggleMute: {
          code: "KeyQ",
          label: "Q",
          ctrl: true,
          alt: false,
          shift: false,
          meta: false,
        },
      },
      false,
    );
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        remapped,
      ),
    ).toBeNull();
    expect(
      matchShortcut(
        keyEvent({ code: "KeyQ", ctrlKey: true, target: plainDiv }),
        remapped,
      ),
    ).toBe("toggleMute");
  });
});

describe("composer focus", () => {
  it("Cmd/Ctrl+Shift+M mutes while the composer is focused", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          metaKey: true,
          shiftKey: true,
          target: composer,
        }),
        MAC,
      ),
    ).toBe("toggleMute");
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
        }),
        WIN,
      ),
    ).toBe("toggleMute");
  });

  it("Cmd/Ctrl+Shift+D deafens while the composer is focused", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyD",
          metaKey: true,
          shiftKey: true,
          target: composer,
        }),
        MAC,
      ),
    ).toBe("toggleDeafen");
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
        }),
        WIN,
      ),
    ).toBe("toggleDeafen");
  });

  it("Cmd/Ctrl+/ still opens the map while the composer is focused", () => {
    expect(
      matchShortcut(
        keyEvent({ code: "Slash", metaKey: true, target: composer }),
        MAC,
      ),
    ).toBe("toggleOverlay");
    expect(
      matchShortcut(
        keyEvent({ code: "Slash", ctrlKey: true, target: composer }),
        WIN,
      ),
    ).toBe("toggleOverlay");
  });

  it("does not fire Alt+↓ while the composer is focused", () => {
    expect(
      matchShortcut(
        keyEvent({ code: "ArrowDown", altKey: true, target: composer }),
        MAC,
      ),
    ).toBeNull();
    expect(
      matchShortcut(
        keyEvent({
          code: "ArrowDown",
          altKey: true,
          shiftKey: true,
          target: composer,
        }),
        WIN,
      ),
    ).toBeNull();
  });

  it("leaves plain letters and Enter to the composer", () => {
    expect(
      matchShortcut(keyEvent({ code: "KeyM", target: composer }), MAC),
    ).toBeNull();
    expect(
      matchShortcut(keyEvent({ code: "Enter", target: composer }), WIN),
    ).toBeNull();
  });

  it("still ignores IME composition and auto-repeat on a mute chord", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
          isComposing: true,
        }),
        WIN,
      ),
    ).toBeNull();
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
          repeat: true,
        }),
        WIN,
      ),
    ).toBeNull();
  });

  it("a remapped letter mute still yields to the composer", () => {
    const remapped = resolveShortcutBindings(
      {
        toggleMute: {
          code: "KeyQ",
          label: "Q",
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
        },
      },
      false,
    );
    expect(
      matchShortcut(keyEvent({ code: "KeyQ", target: composer }), remapped),
    ).toBeNull();
    expect(
      matchShortcut(keyEvent({ code: "KeyQ", target: plainDiv }), remapped),
    ).toBe("toggleMute");
  });

  it("still fires over ordinary page chrome", () => {
    expect(
      matchShortcut(
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: plainDiv,
        }),
        WIN,
      ),
    ).toBe("toggleMute");
  });
});

describe("refuse duplicate binds", () => {
  it("refuses a chord another action already owns", () => {
    const bindings = { ...WIN, pushToTalk: pttDefault };
    expect(
      findBindingConflict(bindings, "toggleDeafen", WIN.toggleMute),
    ).toBe("toggleMute");
    expect(
      findBindingConflict(bindings, "toggleMute", WIN.toggleMute),
    ).toBeNull();
  });

  it("refuses a shortcut that collides with push-to-talk", () => {
    const bindings = { ...WIN, pushToTalk: pttDefault };
    expect(
      findBindingConflict(bindings, "toggleOverlay", pttDefault),
    ).toBe("pushToTalk");
  });

  it("treats two bindings as the same chord even when labels differ", () => {
    const a: KeyBinding = { ...WIN.toggleMute, label: "m" };
    const b: KeyBinding = { ...WIN.toggleMute, label: "M" };
    expect(bindingsEqual(a, b)).toBe(true);
  });
});

describe("stored overrides", () => {
  it("keeps a real remap and drops junk", () => {
    expect(
      parseShortcutOverrides({
        toggleMute: {
          code: "KeyQ",
          label: "Q",
          ctrl: true,
          alt: false,
          shift: false,
          meta: false,
        },
        toggleDeafen: { code: "" },
        notAnAction: WIN.toggleMute,
      }),
    ).toEqual({
      toggleMute: {
        code: "KeyQ",
        label: "Q",
        ctrl: true,
        alt: false,
        shift: false,
        meta: false,
      },
    });
    expect(parseShortcutOverrides(null)).toEqual({});
    expect(parseShortcutOverrides("nope")).toEqual({});
  });
});

describe("channel list motion", () => {
  const channels = [
    { id: "t-late", type: "text", parentId: null, position: 1 },
    { id: "voice-a", type: "voice", parentId: null, position: 0 },
    { id: "cat", type: "category", parentId: null, position: 0 },
    { id: "t-first", type: "text", parentId: null, position: 0 },
    { id: "hidden-shape", type: "category", parentId: "cat", position: 0 },
    { id: "t-in-cat", type: "text", parentId: "cat", position: 1 },
    { id: "v-in-cat", type: "voice", parentId: "cat", position: 0 },
  ];

  it("walks the sidebar order and skips categories", () => {
    expect(navigableChannelIds(channels)).toEqual([
      "t-first",
      "t-late",
      "voice-a",
      "v-in-cat",
      "t-in-cat",
    ]);
  });

  it("steps to the next and previous channel, wrapping", () => {
    const ids = navigableChannelIds(channels);
    expect(stepChannelId(ids, "t-first", 1)).toBe("t-late");
    expect(stepChannelId(ids, "t-in-cat", 1)).toBe("t-first");
    expect(stepChannelId(ids, "t-first", -1)).toBe("t-in-cat");
    expect(stepChannelId(ids, null, 1)).toBe("t-first");
    expect(stepChannelId([], "t-first", 1)).toBeNull();
  });

  it("jumps unread channels and skips the current one", () => {
    const ids = ["a", "b", "c", "d"];
    const unread = {
      b: { count: 2, mentions: 0 },
      d: { count: 0, mentions: 1 },
    };
    const isUnread = (id: string) => channelIsUnread(unread, id);
    expect(stepUnreadChannelId(ids, "a", isUnread, 1)).toBe("b");
    expect(stepUnreadChannelId(ids, "b", isUnread, 1)).toBe("d");
    expect(stepUnreadChannelId(ids, "d", isUnread, 1)).toBe("b");
    expect(stepUnreadChannelId(ids, "c", isUnread, -1)).toBe("b");
    expect(stepUnreadChannelId(ids, "a", () => false, 1)).toBeNull();
  });
});

describe("forums in channel navigation", () => {
  it("walks a top-level forum in the Texto group, where the sidebar draws it", () => {
    expect(
      navigableChannelIds([
        { id: "voice", type: "voice", parentId: null, position: 0 },
        { id: "forum", type: "forum", parentId: null, position: 1 },
        { id: "geral", type: "text", parentId: null, position: 0 },
      ]),
    ).toEqual(["geral", "forum", "voice"]);
  });
});

describe("forumKeyAction", () => {
  const card = { tagName: "ARTICLE", closest: () => null };
  const press = (key: string, extra: Partial<ForumKeyEventLike> = {}) =>
    ({
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      target: card,
      ...extra,
    }) as ForumKeyEventLike;

  it("maps the list keys, either case and arrows included", () => {
    expect(forumKeyAction(press("j"), "list")).toBe("next");
    expect(forumKeyAction(press("J"), "list")).toBe("next");
    expect(forumKeyAction(press("ArrowDown"), "list")).toBe("next");
    expect(forumKeyAction(press("k"), "list")).toBe("previous");
    expect(forumKeyAction(press("ArrowUp"), "list")).toBe("previous");
    expect(forumKeyAction(press("Home"), "list")).toBe("first");
    expect(forumKeyAction(press("End"), "list")).toBe("last");
    expect(forumKeyAction(press("Enter"), "list")).toBe("open");
    expect(forumKeyAction(press("o"), "list")).toBe("open");
    expect(forumKeyAction(press("c"), "list")).toBe("newPost");
    expect(forumKeyAction(press("/"), "list")).toBe("search");
    expect(forumKeyAction(press("x"), "list")).toBeNull();
  });

  it("maps the post keys and nothing else there", () => {
    expect(forumKeyAction(press("Escape"), "post")).toBe("back");
    expect(forumKeyAction(press("u"), "post")).toBe("back");
    expect(forumKeyAction(press("r"), "post")).toBe("reply");
    expect(forumKeyAction(press("c"), "post")).toBeNull();
  });

  it("is a letter while typing, never an action", () => {
    expect(forumKeyAction(press("j", { target: composer }), "list")).toBeNull();
    expect(
      forumKeyAction(press("c", { target: { tagName: "INPUT", type: "text" } }), "list"),
    ).toBeNull();
  });

  it("leaves the app's chords and IME composition alone", () => {
    expect(forumKeyAction(press("ArrowDown", { altKey: true }), "list")).toBeNull();
    expect(forumKeyAction(press("k", { metaKey: true }), "list")).toBeNull();
    expect(forumKeyAction(press("c", { ctrlKey: true }), "list")).toBeNull();
    expect(forumKeyAction(press("j", { isComposing: true }), "list")).toBeNull();
  });

  it("gives the keys to a dialog, a menu or a listbox under focus", () => {
    const inDialog = { tagName: "BUTTON", closest: () => ({}) };
    expect(forumKeyAction(press("j", { target: inDialog }), "list")).toBeNull();
    expect(forumKeyAction(press("Escape", { target: inDialog }), "post")).toBeNull();
    // A plain element outside any of them still gets the action.
    expect(forumKeyAction(press("j", { target: plainDiv }), "list")).toBe("next");
  });

  it("lists every forum key for the overlay", () => {
    expect(FORUM_KEY_ROWS.map((row) => row.id)).toEqual([
      "forumMove",
      "forumOpen",
      "forumNew",
      "forumSearch",
      "forumBack",
      "forumReply",
    ]);
  });
});
