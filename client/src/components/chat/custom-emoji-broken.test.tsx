// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEmoji, ServerEmojiList } from "@pqp/shared";
import { CustomEmojiImage, CustomEmojiProvider } from "./custom-emoji";
import { MessageBody } from "./message-body";
import { getCachedServerEmoji, setServerEmojiList } from "@/lib/server-emoji";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const POG = "3f2a1c9e-0b1d-4c5e-8f6a-7b8c9d0e1f2a";

const FIRST_SERVER = "55555555-5555-4555-8555-555555555555";

function emojiFor(serverId: string): ServerEmoji {
  return { ...POG_EMOJI, serverId };
}

const POG_EMOJI: ServerEmoji = {
  id: POG,
  serverId: FIRST_SERVER,
  name: "pog",
  url: `/api/emoji/${POG}?v=abcd1234`,
  createdBy: null,
  createdByName: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};

function listOf(serverId: string, present: boolean): ServerEmojiList {
  return {
    emoji: present ? [emojiFor(serverId)] : [],
    limit: 50,
    uploadEnabled: true,
    maxBytes: 262144,
    size: 128,
  };
}

/** A fetch stub that answers the emoji list read with `list`. */
function stubListRead(list: ServerEmojiList) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(list), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

function mountMessages(serverId: string, count = 1) {
  return mount(
    <CustomEmojiProvider serverId={serverId}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} data-testid="msg">
          <MessageBody body={`gg <:pog:${POG}>`} currentUsername={null} />
        </div>
      ))}
    </CustomEmojiProvider>,
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function failImage(container: HTMLElement) {
  const img = container.querySelector("img");
  expect(img).not.toBeNull();
  act(() => {
    img!.dispatchEvent(new Event("error"));
  });
}

describe("CustomEmojiImage", () => {
  it("shows :name: text when the picture fails to load, and says so once", () => {
    const onBroken = vi.fn();
    const el = mount(<CustomEmojiImage emoji={POG_EMOJI} onBroken={onBroken} />);
    failImage(el);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toBe(":pog:");
    expect(onBroken).toHaveBeenCalledTimes(1);
  });
});

describe("a failed emoji picture in a message", () => {
  it("shows :name: for that image and asks for one refresh, keeping a valid emoji", async () => {
    const server = "66666666-6666-4666-8666-666666666661";
    const fetchMock = stubListRead(listOf(server, true));
    setServerEmojiList(server, listOf(server, true));
    const el = mountMessages(server);
    failImage(el);

    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(":pog:");
    // Nothing is evicted on the error itself.
    expect(getCachedServerEmoji(server)?.emoji).toHaveLength(1);

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The refresh still lists it (a network blip, not a delete): it stays.
    expect(getCachedServerEmoji(server)?.emoji).toHaveLength(1);
  });

  it("drops the emoji everywhere once a refresh no longer lists it", async () => {
    const server = "66666666-6666-4666-8666-666666666662";
    stubListRead(listOf(server, false));
    setServerEmojiList(server, listOf(server, true));
    const el = mountMessages(server, 2);
    const images = el.querySelectorAll("img");
    expect(images).toHaveLength(2);
    act(() => {
      images[0]!.dispatchEvent(new Event("error"));
    });
    await settle();

    expect(getCachedServerEmoji(server)?.emoji).toEqual([]);
    expect(el.querySelector("img")).toBeNull();
    for (const message of el.querySelectorAll("[data-testid=msg]")) {
      expect(message.textContent).toContain(":pog:");
    }
  });

  it("does not loop on repeated errors", async () => {
    const server = "66666666-6666-4666-8666-666666666663";
    const fetchMock = stubListRead(listOf(server, true));
    setServerEmojiList(server, listOf(server, true));
    const el = mountMessages(server, 3);
    for (const img of Array.from(el.querySelectorAll("img"))) {
      act(() => {
        img.dispatchEvent(new Event("error"));
      });
      await settle();
    }
    expect(el.querySelector("img")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
