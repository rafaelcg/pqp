// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEmoji, ServerEmojiList } from "@pqp/shared";
import { CustomEmojiImage, CustomEmojiProvider } from "./custom-emoji";
import { MessageBody } from "./message-body";
import { getCachedServerEmoji, setServerEmojiList } from "@/lib/server-emoji";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = "55555555-5555-4555-8555-555555555555";
const POG = "3f2a1c9e-0b1d-4c5e-8f6a-7b8c9d0e1f2a";

const POG_EMOJI: ServerEmoji = {
  id: POG,
  serverId: SERVER,
  name: "pog",
  url: `/api/emoji/${POG}?v=abcd1234`,
  createdBy: null,
  createdByName: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};

const LIST: ServerEmojiList = {
  emoji: [POG_EMOJI],
  limit: 50,
  uploadEnabled: true,
  maxBytes: 262144,
  size: 128,
};

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

describe("a deleted emoji in a message", () => {
  it("falls back to :name:, forgets the id, and does not loop", async () => {
    // The refresh still lists the emoji (a transient failure, not a delete).
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(LIST), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setServerEmojiList(SERVER, LIST);
    const el = mount(
      <CustomEmojiProvider serverId={SERVER}>
        <MessageBody body={`gg <:pog:${POG}>`} currentUsername={null} />
      </CustomEmojiProvider>,
    );
    expect(el.querySelector("img")).not.toBeNull();

    failImage(el);

    expect(getCachedServerEmoji(SERVER)?.emoji).toEqual([]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(":pog:");

    // The unknown id asks for one refresh. If the list brings the emoji back
    // and its picture fails again, the 30 s throttle stops a second read.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const reads = fetchMock.mock.calls.length;
    expect(reads).toBe(1);
    if (el.querySelector("img")) {
      failImage(el);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain(":pog:");
  });
});
