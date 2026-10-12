// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSidebarLayout,
  stepInLayout,
  type Channel,
  type Server,
  type SidebarLayout,
} from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChannelList } from "./channel-list";
import { stepAvailability } from "./channel-list-mixed";

/**
 * THE MIXED CHANNEL LIST (`mixed_channel_list`), driven with the events a
 * browser sends. What is pinned: no TEXTO / VOZ / CATEGORIAS when mixed; the
 * "+" and "Criar categoria" only for managers; empty categories hidden from
 * members; a drop above or below the middle of a row lands before or after it;
 * a drop on a header or an empty category appends; categories reorder among
 * categories; a person dragged between rooms never reorders anything; a pin
 * dragged by a member still pins; a folded category keeps where you are; a
 * stale write says so. The flag-off list is pinned by the other
 * `channel-list-*.test.tsx` files, untouched.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has neither; the truncation tooltips and the width hook ask for both.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= NoopResizeObserver;
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

const server: Server = {
  id: SERVER_ID,
  name: "Resenha dos Guris",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  createdAt: "2026-07-01T00:00:00.000Z",
  messageRetentionDays: null,
  ssoEmailDomain: null,
  iconUrl: null,
  bannerUrl: null,
  role: "owner",
  isCommunity: false,
  communityHomeEnabled: false,
  showOnProfile: true,
  communityTagline: null,
  communityAbout: null,
  communityLinks: [],
  communitySlug: null,
};

function channel(
  id: string,
  name: string,
  type: Channel["type"],
  parentId: string | null,
  position: number,
): Channel {
  return {
    id,
    serverId: SERVER_ID,
    kind: "server",
    name,
    type,
    position,
    parentId,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
  };
}

const CANAIS = "c0000000-0000-4000-8000-000000000001";
const JOGOS = "c0000000-0000-4000-8000-000000000002";
const CINEMA = "c0000000-0000-4000-8000-000000000003";
const GENERAL = "a0000000-0000-4000-8000-000000000001";
const LOBBY = "a0000000-0000-4000-8000-000000000002";
const DUVIDAS = "a0000000-0000-4000-8000-000000000003";
const CLIPES = "a0000000-0000-4000-8000-000000000004";
const SQUAD = "a0000000-0000-4000-8000-000000000005";

const channels: Channel[] = [
  channel(CANAIS, "Canais", "category", null, 0),
  channel(JOGOS, "Jogos", "category", null, 1),
  channel(CINEMA, "Cinema", "category", null, 2),
  channel(GENERAL, "general", "text", CANAIS, 0),
  channel(LOBBY, "Lobby", "voice", CANAIS, 1),
  channel(DUVIDAS, "duvidas", "forum", CANAIS, 2),
  channel(CLIPES, "clipes", "text", JOGOS, 0),
  channel(SQUAD, "Squad", "voice", JOGOS, 1),
];

type Props = ComponentProps<typeof ChannelList>;

let root: Root | null = null;
let host: HTMLElement | null = null;

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    server,
    channels,
    selectedChannelId: null,
    canManage: true,
    voiceOccupancy: {},
    speakingPeerIds: [],
    activeVoiceChannelId: null,
    unread: {},
    onSelectChannel: () => {},
    onCreateChannel: () => {},
    onRenameChannel: () => {},
    onDeleteChannel: () => {},
    onOpenChannelSettings: () => {},
    onMoveChannel: () => {},
    onInvite: () => {},
    onOpenMembers: () => {},
    onOpenServerSettings: () => {},
    mixedLayout: { version: 7 },
    onApplyLayout: vi.fn(async () => "ok" as const),
    ...overrides,
  };
}

function mount(props: Props) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <TooltipProvider>
          <ChannelList {...props} />
        </TooltipProvider>
      </MemoryRouter>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function dataTransfer(): DataTransfer {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    types: [],
    setData: () => {},
    setDragImage: () => {},
    getData: () => "",
  } as unknown as DataTransfer;
}

function fire(type: string, target: Element, init: { clientY?: number } = {}): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer() });
  Object.defineProperty(event, "clientY", { value: init.clientY ?? 0 });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** dragstart, then the tick the list waits before it reacts (see `onDragStart`). */
async function startDrag(target: Element): Promise<void> {
  fire("dragstart", target);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every row is 20px tall at y = 100, so 105 is the upper half and 115 the lower. */
function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 120,
    height: 20,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: 100,
    toJSON: () => ({}),
  } as DOMRect);
}

function row(container: HTMLElement, id: string): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(`[data-channel-id="${id}"]`);
  expect(wrapper, `row ${id}`).toBeTruthy();
  // The draggable element is the ChannelRow inside the wrapper.
  return wrapper!.querySelector<HTMLElement>("[draggable]")!;
}

function header(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-category-id="${id}"]`);
  expect(element, `header ${id}`).toBeTruthy();
  return element!;
}

function named(layout: SidebarLayout<Channel>) {
  return {
    loose: layout.loose.map((c) => c.name),
    categories: layout.categories.map((entry) => [
      entry.category.name,
      entry.children.map((c) => c.name),
    ]),
  };
}

function appliedLayout(spy: Props["onApplyLayout"]) {
  const mock = vi.mocked(spy!);
  expect(mock).toHaveBeenCalledTimes(1);
  const [layout, version] = mock.mock.calls[0]!;
  expect(version).toBe(7);
  return named(layout);
}

describe("mixed channel list: what is drawn", () => {
  it("draws categories as the only headers, loose channels on top, and Criar categoria last", () => {
    const loose = channel("a0000000-0000-4000-8000-000000000009", "avisos", "text", null, 0);
    const container = mount(baseProps({ channels: [...channels, loose] }));
    const text = container.textContent ?? "";
    expect(container.querySelector("[data-channel-list-mixed]")).toBeTruthy();
    expect(text).not.toMatch(/\bText\b|\bVoice\b|\bCategories\b/);
    const order = [
      ...container.querySelectorAll<HTMLElement>("[data-channel-id], [data-category-id]"),
    ].map((element) => element.dataset.channelId ?? `#${element.dataset.categoryId}`);
    expect(order).toEqual([
      loose.id,
      `#${CANAIS}`,
      GENERAL,
      LOBBY,
      DUVIDAS,
      `#${JOGOS}`,
      CLIPES,
      SQUAD,
      `#${CINEMA}`,
    ]);
    expect(container.querySelector("[data-create-category]")?.textContent).toContain(
      "Create category",
    );
    expect(container.querySelectorAll("[data-category-add]")).toHaveLength(3);
    expect(container.querySelector('[data-testid="empty-category-drop"]')?.textContent).toBe(
      "Empty. Drag a channel here.",
    );
  });

  it("gives a member no Criar categoria, no +, and no empty category", () => {
    const container = mount(baseProps({ canManage: false }));
    expect(container.querySelector("[data-create-category]")).toBeNull();
    expect(container.querySelector("[data-category-add]")).toBeNull();
    expect(container.querySelector(`[data-category-id="${CINEMA}"]`)).toBeNull();
    expect(container.querySelector(`[data-category-id="${JOGOS}"]`)).toBeTruthy();
  });

  it("a folded category keeps the open channel and the call you are in, and says how many it holds", () => {
    localStorage.setItem("pqp:collapsed-categories", JSON.stringify([JOGOS]));
    try {
      const container = mount(
        baseProps({
          selectedChannelId: CLIPES,
          activeVoiceChannelId: SQUAD,
          channels: [...channels, channel("a0000000-0000-4000-8000-000000000010", "lfg", "text", JOGOS, 2)],
        }),
      );
      const group = container.querySelector<HTMLElement>(`[data-category-group="${JOGOS}"]`)!;
      const shown = [...group.querySelectorAll<HTMLElement>("[data-channel-id]")].map(
        (element) => element.dataset.channelId,
      );
      expect(shown).toEqual([CLIPES, SQUAD]);
      expect(header(container, JOGOS).textContent).toContain("3 channels");
    } finally {
      localStorage.removeItem("pqp:collapsed-categories");
    }
  });
});

describe("mixed channel list: dragging", () => {
  it("draws the line above or below the row under the pointer, and drops there", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));

    fire("dragstart", row(container, LOBBY));
    // Never inside dragstart (Chromium would cancel the drag): a tick later,
    // the origin stays as a dashed gap.
    expect(container.querySelector(`[data-channel-id="${LOBBY}"]`)!.className).not.toContain(
      "outline-dashed",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector(`[data-channel-id="${LOBBY}"]`)!.className).toContain(
      "outline-dashed",
    );
    expect(container.querySelector("[data-drag-status]")?.textContent).toContain("Drop to move.");

    fire("dragover", row(container, SQUAD), { clientY: 105 });
    expect(container.querySelector(`[data-channel-id="${SQUAD}"] [data-drop-line="before"]`)).toBeTruthy();
    fire("dragover", row(container, SQUAD), { clientY: 115 });
    expect(container.querySelector(`[data-channel-id="${SQUAD}"] [data-drop-line="after"]`)).toBeTruthy();
    fire("dragover", row(container, CLIPES), { clientY: 115 });
    fire("drop", row(container, CLIPES), { clientY: 115 });

    expect(appliedLayout(onApplyLayout)).toEqual({
      loose: [],
      categories: [
        ["Canais", ["general", "duvidas"]],
        ["Jogos", ["clipes", "Lobby", "Squad"]],
        ["Cinema", []],
      ],
    });
  });

  it("a drop below the row right above the dragged one is no move at all", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, LOBBY));
    fire("dragover", row(container, GENERAL), { clientY: 115 });
    fire("drop", row(container, GENERAL), { clientY: 115 });
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a header lights up and says where the channel goes; a drop appends to it", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, GENERAL));
    fire("dragover", header(container, JOGOS), { clientY: 112 });
    expect(header(container, JOGOS).dataset.drop).toBe("into");
    expect(header(container, JOGOS).textContent).toContain("Drop in Jogos");
    fire("drop", header(container, JOGOS), { clientY: 112 });
    expect(appliedLayout(onApplyLayout).categories[1]).toEqual(["Jogos", ["clipes", "Squad", "general"]]);
  });

  it("a folded category held under a dragged channel opens after 600 ms", () => {
    vi.useFakeTimers();
    localStorage.setItem("pqp:collapsed-categories", JSON.stringify([JOGOS]));
    try {
      stubRects();
      const container = mount(baseProps());
      const shown = () =>
        container.querySelectorAll(`[data-category-group="${JOGOS}"] [data-channel-id]`).length;
      expect(shown()).toBe(0);
      fire("dragstart", row(container, GENERAL));
      act(() => {
        vi.advanceTimersByTime(1);
      });
      fire("dragover", header(container, JOGOS), { clientY: 112 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(shown()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(150);
      });
      expect(shown()).toBe(2);
    } finally {
      localStorage.removeItem("pqp:collapsed-categories");
      vi.useRealTimers();
    }
  });

  it("the empty category placeholder takes the drop", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, DUVIDAS));
    const placeholder = container.querySelector<HTMLElement>('[data-testid="empty-category-drop"]')!;
    fire("dragover", placeholder);
    fire("drop", placeholder);
    expect(appliedLayout(onApplyLayout).categories[2]).toEqual(["Cinema", ["duvidas"]]);
  });

  it("a category drops between categories, never inside one", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(header(container, CINEMA));
    fire("dragover", row(container, GENERAL), { clientY: 105 });
    expect(container.querySelector("[data-drop-line]")).toBeNull();
    fire("dragover", header(container, CANAIS), { clientY: 105 });
    expect(header(container, CANAIS).dataset.drop).toBe("before");
    fire("drop", header(container, CANAIS), { clientY: 105 });
    expect(appliedLayout(onApplyLayout).categories.map(([name]) => name)).toEqual([
      "Cinema",
      "Canais",
      "Jogos",
    ]);
  });

  it("the top edge of a header means above it: out of every category for the first one", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, SQUAD));
    fire("dragover", header(container, CANAIS), { clientY: 102 });
    expect(header(container, CANAIS).dataset.drop).toBe("before");
    expect(container.querySelector(`[data-category-id="${CANAIS}"] [data-drop-line="before"]`)).toBeTruthy();
    fire("drop", header(container, CANAIS), { clientY: 102 });
    expect(appliedLayout(onApplyLayout).loose).toEqual(["Squad"]);
  });

  it("the top edge of a later header lands at the end of the category above it", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, GENERAL));
    fire("dragover", header(container, CINEMA), { clientY: 102 });
    fire("drop", header(container, CINEMA), { clientY: 102 });
    expect(appliedLayout(onApplyLayout).categories[1]).toEqual(["Jogos", ["clipes", "Squad", "general"]]);
  });

  it("nothing in the list moves when a drag starts", async () => {
    stubRects();
    const container = mount(baseProps({ onFavoriteChannelIdsChange: vi.fn() }));
    const before = [...container.querySelectorAll("[data-channel-list-mixed] > *")].length;
    const pinnedBefore = container.querySelectorAll("[data-pinned-channels]").length;
    await startDrag(row(container, SQUAD));
    expect([...container.querySelectorAll("[data-channel-list-mixed] > *")].length).toBe(before);
    expect(container.querySelectorAll("[data-pinned-channels]").length).toBe(pinnedBefore);
    // The pin target is a bar under the list instead.
    expect(container.querySelector("[data-pin-drop]")).toBeTruthy();
  });

  it("dragend without a drop (Esc) moves nothing and clears the line", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, LOBBY));
    fire("dragover", row(container, CLIPES), { clientY: 105 });
    fire("dragend", row(container, LOBBY));
    expect(container.querySelector("[data-drop-line]")).toBeNull();
    expect(container.querySelector("[data-drag-status]")).toBeNull();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a person dragged to another room moves the person, never the list", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const onMoveVoiceOccupant = vi.fn();
    const container = mount(
      baseProps({
        onApplyLayout,
        onMoveVoiceOccupant,
        canMoveIn: () => true,
        currentUserId: "u-self",
        voiceOccupancy: {
          [LOBBY]: [
            {
              peerId: "p-1",
              userId: "u-ana",
              displayName: "Ana",
              avatarUrl: null,
              muted: false,
              deafened: false,
            } as unknown as NonNullable<Props["voiceOccupancy"]>[string][number],
          ],
        },
      }),
    );
    const occupant = container.querySelector<HTMLElement>('[data-voice-occupant="u-ana"]')!;
    expect(occupant).toBeTruthy();
    await startDrag(occupant.closest("[draggable]") ?? occupant);
    fire("dragover", row(container, SQUAD), { clientY: 105 });
    expect(container.querySelector("[data-drop-line]")).toBeNull();
    fire("drop", row(container, SQUAD), { clientY: 105 });
    expect(onMoveVoiceOccupant).toHaveBeenCalledWith("u-ana", SQUAD);
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a channel let go over a room's occupants lands after the room (they count as the row)", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(
      baseProps({
        onApplyLayout,
        voiceOccupancy: {
          [LOBBY]: [
            {
              peerId: "p-1",
              userId: "u-ana",
              displayName: "Ana",
              avatarUrl: null,
              muted: false,
              deafened: false,
            } as unknown as NonNullable<Props["voiceOccupancy"]>[string][number],
          ],
        },
      }),
    );
    await startDrag(row(container, CLIPES));
    const occupant = container.querySelector<HTMLElement>('[data-voice-occupant="u-ana"]')!;
    fire("dragover", occupant, { clientY: 115 });
    expect(container.querySelector(`[data-channel-id="${LOBBY}"] [data-drop-line="after"]`)).toBeTruthy();
    fire("drop", occupant, { clientY: 115 });
    expect(appliedLayout(onApplyLayout).categories[0]).toEqual([
      "Canais",
      ["general", "Lobby", "clipes", "duvidas"],
    ]);
  });

  it("flag off: a drop on a loose row sends the per-type index and the row it landed on", async () => {
    stubRects();
    const onMoveChannel = vi.fn();
    const loose = [
      channel("b0000000-0000-4000-8000-000000000001", "general", "text", null, 0),
      channel("b0000000-0000-4000-8000-000000000002", "Lobby", "voice", null, 1),
      channel("b0000000-0000-4000-8000-000000000003", "test", "text", null, 2),
      channel("b0000000-0000-4000-8000-000000000004", "Squad", "voice", null, 3),
    ];
    const container = mount(baseProps({ channels: loose, mixedLayout: null, onMoveChannel }));
    await startDrag(row(container, loose[3]!.id));
    fire("dragover", row(container, loose[1]!.id), { clientY: 105 });
    fire("drop", row(container, loose[1]!.id), { clientY: 105 });
    // Lobby is the first voice room: index 0 of VOZ, whatever its position.
    expect(onMoveChannel).toHaveBeenCalledWith(loose[3]!.id, null, 0, loose[1]!.id);
  });

  it("a member can still drag a channel onto Pinados", async () => {
    stubRects();
    const onFavoriteChannelIdsChange = vi.fn();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(
      baseProps({ canManage: false, onFavoriteChannelIdsChange, onApplyLayout }),
    );
    await startDrag(row(container, CLIPES));
    // Nothing pinned yet: the bar under the list takes the pin.
    expect(container.querySelector("[data-drag-status]")).toBeNull();
    const pinned = container.querySelector<HTMLElement>("[data-pin-drop]")!;
    fire("dragover", pinned);
    fire("drop", pinned);
    expect(onFavoriteChannelIdsChange).toHaveBeenCalledWith([CLIPES]);
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("a stale list says so in the status line", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "stale" as const);
    const container = mount(baseProps({ onApplyLayout }));
    await startDrag(row(container, GENERAL));
    fire("dragover", header(container, JOGOS), { clientY: 112 });
    fire("drop", header(container, JOGOS), { clientY: 112 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector("[data-channel-list-status]")?.textContent).toBe(
      "Couldn't move it. The list changed, try again.",
    );
  });

  it("holds every reorder back until the version is known", async () => {
    stubRects();
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout, mixedLayout: { version: null } }));
    await startDrag(row(container, GENERAL));
    fire("dragover", header(container, JOGOS), { clientY: 112 });
    fire("drop", header(container, JOGOS), { clientY: 112 });
    expect(onApplyLayout).not.toHaveBeenCalled();
  });
});

function openContextMenu(target: Element) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

function menuItem(label: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
    (element) => element.textContent?.trim() === label,
  );
  expect(item, `menu item ${label}`).toBeTruthy();
  return item!;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("mixed channel list: without a mouse", () => {
  it("Move up on the first row of a category crosses into the one above, and says where it went", async () => {
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    openContextMenu(row(container, CLIPES));
    act(() => menuItem("Move up").click());
    await settle();
    expect(appliedLayout(onApplyLayout).categories.slice(0, 2)).toEqual([
      ["Canais", ["general", "Lobby", "duvidas", "clipes"]],
      ["Jogos", ["Squad"]],
    ]);
    expect(container.querySelector("[data-channel-list-status]")?.textContent).toBe(
      "clipes moved to Canais, position 4 of 4.",
    );
  });

  it("a category's menu moves it among categories", async () => {
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    openContextMenu(header(container, CANAIS));
    act(() => menuItem("Move down").click());
    await settle();
    expect(appliedLayout(onApplyLayout).categories.map(([name]) => name)).toEqual([
      "Jogos",
      "Canais",
      "Cinema",
    ]);
  });

  it("Organizar canais stages moves and sends them once on Concluir; Cancelar sends nothing", async () => {
    const onApplyLayout = vi.fn(async () => "ok" as const);
    const container = mount(baseProps({ onApplyLayout }));
    const serverHeader = container.querySelector<HTMLElement>("[data-server-header]")!;

    openContextMenu(serverHeader);
    act(() => menuItem("Organize channels").click());
    const organize = container.querySelector<HTMLElement>("[data-organize-channels]")!;
    expect(organize).toBeTruthy();
    const button = (label: string) =>
      [...organize.querySelectorAll<HTMLButtonElement>("button")].find(
        (element) => element.getAttribute("aria-label") === label || element.textContent === label,
      )!;
    act(() => button("Move Squad up").click());
    act(() => button("Move Squad up").click());
    act(() => button("Cancel").click());
    expect(onApplyLayout).not.toHaveBeenCalled();
    expect(container.querySelector("[data-organize-channels]")).toBeNull();

    openContextMenu(serverHeader);
    act(() => menuItem("Organize channels").click());
    const again = container.querySelector<HTMLElement>("[data-organize-channels]")!;
    const press = (label: string) =>
      act(() =>
        [...again.querySelectorAll<HTMLButtonElement>("button")]
          .find((element) => element.getAttribute("aria-label") === label || element.textContent === label)!
          .click(),
      );
    press("Move Squad up");
    press("Move Squad up");
    press("Move Jogos up");
    press("Done");
    await settle();
    expect(appliedLayout(onApplyLayout)).toEqual({
      loose: [],
      categories: [
        ["Jogos", ["clipes"]],
        ["Canais", ["general", "Lobby", "duvidas", "Squad"]],
        ["Cinema", []],
      ],
    });
  });

  it("a member's server menu has no Organizar canais", () => {
    const container = mount(baseProps({ canManage: false }));
    openContextMenu(container.querySelector("[data-server-header]")!);
    const labels = [...document.querySelectorAll("[role='menuitem']")].map((element) =>
      element.textContent?.trim(),
    );
    // The menu did open (so the absence means something).
    expect(labels).toContain("Members");
    expect(labels).not.toContain("Organize channels");
  });
});

describe("stepAvailability", () => {
  it("agrees with stepInLayout for every row and header, empty groups included", () => {
    const loose = channel("a0000000-0000-4000-8000-000000000099", "avisos", "text", null, 0);
    for (const list of [channels, [...channels, loose], channels.filter((c) => c.parentId !== JOGOS)]) {
      const layout = buildSidebarLayout(list, { mixed: true });
      const steps = stepAvailability(layout);
      for (const item of list) {
        expect(steps.get(item.id), item.name).toEqual({
          up: stepInLayout(layout, item.id, -1) !== null,
          down: stepInLayout(layout, item.id, 1) !== null,
        });
      }
    }
  });
});

describe("mixed channel list: the shared layout it draws", () => {
  it("is the shared layout's order, pins left out", () => {
    const layout = buildSidebarLayout(channels, { mixed: true });
    expect(named(layout).categories.map(([name]) => name)).toEqual(["Canais", "Jogos", "Cinema"]);
  });
});
