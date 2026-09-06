import { describe, expect, it } from "vitest";
import {
  bindingsEqual,
  channelIsUnread,
  defaultShortcutBindings,
  findBindingConflict,
  matchShortcut,
  navigableChannelIds,
  parseShortcutOverrides,
  resolveShortcutBindings,
  stepChannelId,
  stepUnreadChannelId,
  type ShortcutAction,
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

describe("isTextEntryTarget suppresses", () => {
  it("does not fire mute, deafen or channel motion in the composer", () => {
    const cases: Array<[ShortcutAction, KeyEventLike]> = [
      [
        "toggleMute",
        keyEvent({
          code: "KeyM",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
        }),
      ],
      [
        "toggleDeafen",
        keyEvent({
          code: "KeyD",
          ctrlKey: true,
          shiftKey: true,
          target: composer,
        }),
      ],
      [
        "nextChannel",
        keyEvent({ code: "ArrowDown", altKey: true, target: composer }),
      ],
      [
        "toggleOverlay",
        keyEvent({ code: "Slash", metaKey: true, target: composer }),
      ],
    ];
    for (const [action, event] of cases) {
      expect(matchShortcut(event, WIN), action).toBeNull();
      expect(matchShortcut(event, MAC), action).toBeNull();
    }
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
