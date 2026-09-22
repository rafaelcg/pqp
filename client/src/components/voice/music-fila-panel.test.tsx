// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MusicState, MusicTrack } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { VoiceState } from "@/hooks/use-voice";
import {
  getMusicSnapshot,
  receiveMusic,
  resetMusicStoreForTests,
  setMusicOpen,
  setMusicSession,
} from "@/lib/music-store";
import { resetMusicPrefsForTests } from "@/lib/music-prefs";
import { translateMessage } from "@/lib/i18n";
import { HINTS_PERSIST_OVERRIDE_KEY } from "@/lib/hints";
import {
  MUSIC_PIP_KEY,
  musicPipSpent,
  resetMusicPipForTests,
} from "@/lib/music-pip";
import { MusicFila } from "@/components/voice/music-fila";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no ResizeObserver, and the seek slider's Radix thumb measures itself.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

// jsdom has no layout, so the field's focus scroll is a no-op here.
Element.prototype.scrollIntoView = () => {};

const CHANNEL = "11111111-1111-4111-8111-111111111111";

const track = (id: string, title = `Track ${id}`): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: id.padEnd(11, "a").slice(0, 11),
  title,
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: 180_000,
  addedByUserId: "22222222-2222-4222-8222-222222222222",
  addedByName: "Ana",
});

const state = (partial: Partial<MusicState> = {}): MusicState => ({
  current: track("now", "Tocando agora mesmo"),
  queue: [],
  status: "playing",
  positionMs: 0,
  atMs: 1,
  rev: 1,
  actorId: "peer-ana",
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
  ...partial,
});

const voiceState = (): VoiceState =>
  ({
    status: "connected",
    peerId: "peer-me",
    canSpeak: true,
    canStream: true,
    canManageMusic: true,
    voiceChannelId: CHANNEL,
    self: {
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      avatarUrl: null,
    },
    occupancy: { [CHANNEL]: [] },
    speakingPeerIds: [],
    isDeafened: false,
    isTransmitting: false,
    channelMusic: {},
  }) as unknown as VoiceState;

let host: HTMLDivElement;
let root: Root;

function mount(variant: "sheet" | "drawer" = "sheet") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <TooltipProvider>
        <MusicFila variant={variant} voiceState={voiceState()} />
      </TooltipProvider>,
    );
  });
}

describe("the Fila panel is one column", () => {
  beforeEach(() => {
    resetMusicStoreForTests();
    resetMusicPrefsForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
    receiveMusic(CHANNEL, state({ queue: [track("q1", "Daft Punk"), track("q2", "Racionais")] }));
    setMusicOpen(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("keeps the field mounted while a track plays, with nothing pressed", () => {
    mount();
    expect(host.querySelector("[data-music-search]")).not.toBeNull();
    expect(host.querySelector("input")).not.toBeNull();
  });

  it("shows the queue and the field at the same time", () => {
    mount();
    expect(host.querySelector("[data-music-search]")).not.toBeNull();
    expect(host.textContent).toContain("Daft Punk");
    expect(host.textContent).toContain("Racionais");
  });

  it("drops the header's add button, because the field is always there", () => {
    mount();
    expect(host.querySelector("[data-music-add]")).toBeNull();
  });

  it("closes the panel on Escape from an empty field", () => {
    mount();
    const field = host.querySelector("input") as HTMLInputElement;
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(getMusicSnapshot().open).toBe(false);
  });

  /*
   * The sources line used to render only when nothing was playing, so
   * opening the queue mid-song left the field standing alone with no
   * answer to "what can I put in here".
   */
  it("says what the field takes while a track is playing", () => {
    mount();
    const blurb = host.querySelector("[data-music-empty]");
    expect(blurb).not.toBeNull();
    expect(blurb?.textContent).toContain(translateMessage("music.empty.sources"));
    // The long explanation belongs to the empty room, not to every open.
    expect(blurb?.textContent).not.toContain(translateMessage("music.empty.what"));
  });

  it("drops it again once there is something in the field", () => {
    mount();
    const field = host.querySelector("input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(field, "daft punk");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("[data-music-empty]")).toBeNull();
  });

  it("says what may be pasted when the room has nothing on", () => {
    resetMusicStoreForTests();
    setMusicSession({
      channelId: CHANNEL,
      peerId: "peer-me",
      userId: "33333333-3333-4333-8333-333333333333",
      displayName: "Eu",
      send: () => {},
    });
    setMusicOpen(true);
    mount();
    const text = host.textContent ?? "";
    expect(text).toContain(translateMessage("music.empty.what"));
    expect(text).toContain(translateMessage("music.empty.sources"));
    /* The field leads; the explanation is under it, not over it. */
    const search = host.querySelector("[data-music-search]");
    const blurb = host.querySelector("[data-music-empty]");
    expect(blurb).not.toBeNull();
    expect(
      search!.compareDocumentPosition(blurb!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("closes when something elsewhere is pressed", () => {
    mount();
    const away = document.createElement("button");
    document.body.appendChild(away);
    act(() => {
      away.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(getMusicSnapshot().open).toBe(false);
    away.remove();
  });

  /* Both of these toggle the panel. Closing before their click lands would
     leave the tile reopening what it had just shut. */
  it("stays open for a press on the player or on the dock tile", () => {
    mount();
    const composer = document.createElement("div");
    composer.setAttribute("data-music-composer", "");
    const inner = document.createElement("button");
    composer.appendChild(inner);
    document.body.appendChild(composer);
    act(() => {
      inner.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(getMusicSnapshot().open).toBe(true);

    const tile = document.createElement("button");
    tile.setAttribute("data-music-dock", "playing");
    document.body.appendChild(tile);
    act(() => {
      tile.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(getMusicSnapshot().open).toBe(true);
    composer.remove();
    tile.remove();
  });

  it("stays open for a press inside a menu it opened", () => {
    mount();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const row = document.createElement("button");
    menu.appendChild(row);
    document.body.appendChild(menu);
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(getMusicSnapshot().open).toBe(true);
    menu.remove();
  });

  it("puts the field above the queue in the drawer too", () => {
    mount("drawer");
    const search = host.querySelector("[data-music-search]");
    const queue = host.querySelector("[data-music-queue]");
    expect(search).not.toBeNull();
    expect(queue).not.toBeNull();
    expect(
      search!.compareDocumentPosition(queue!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /*
   * The one sentence that says the field takes a search as well as a link
   * is the placeholder, so it only gets shortened where it does not fit.
   */
  it("names YouTube and a search in the sheet's placeholder", () => {
    mount();
    const field = host.querySelector("input") as HTMLInputElement;
    expect(field.placeholder).toBe(translateMessage("music.placeholder.field"));
    expect(field.placeholder).toContain("YouTube");
  });

  it("keeps the short one in the 240px drawer", () => {
    mount("drawer");
    const field = host.querySelector("input") as HTMLInputElement;
    expect(field.placeholder).toBe(translateMessage("music.placeholder.short"));
  });

  it("says it before anything is playing too", () => {
    receiveMusic(CHANNEL, state({ current: null, queue: [], status: "paused" }));
    mount();
    const field = host.querySelector("input") as HTMLInputElement;
    expect(field.placeholder).toBe(translateMessage("music.placeholder.field"));
  });

  /*
   * The tile's NOVO mark says "there is something here you have not opened".
   * Opening it is what answers that, whichever of the four ways in was used,
   * so the panel spends the mark rather than the tile that happens to be one
   * of them.
   */
  it("spends the tile's NOVO mark, however the panel was opened", () => {
    window.localStorage.setItem(HINTS_PERSIST_OVERRIDE_KEY, "1");
    resetMusicPipForTests();
    expect(musicPipSpent()).toBe(false);
    mount();
    expect(musicPipSpent()).toBe(true);
    expect(window.localStorage.getItem(MUSIC_PIP_KEY)).toBe("1");
  });
});
