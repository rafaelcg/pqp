// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicUser } from "@pqp/shared";
import type { CommunityHomePost } from "@/lib/community-home";
import {
  ChannelRefsProvider,
  ChannelText,
  useChannelPicker,
} from "./community-home-channel-refs";
import { PostCard } from "./community-home-feed";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SERVER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const GERAL = "11111111-2222-4333-8444-555555555555";
const VOZ = "22222222-2222-4333-8444-555555555555";
const SECRET = "33333333-2222-4333-8444-555555555555";

const channels = [
  { id: GERAL, name: "geral", type: "text", topic: "papo geral" },
  { id: VOZ, name: "sala-de-voz", type: "voice" },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

// jsdom has no layout; the menu scrolls the selected row into view.
Element.prototype.scrollIntoView = vi.fn();

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = host = null;
});

describe("ChannelText", () => {
  it("links a stored reference to the channel of the post's server", () => {
    const html = renderToStaticMarkup(
      <ChannelRefsProvider serverId={SERVER} channels={channels}>
        <ChannelText text={`manda no <#${GERAL}> hoje`} />
      </ChannelRefsProvider>,
    );
    expect(html).toContain(`href="/app/server/${SERVER}/channel/${GERAL}"`);
    expect(html).toContain("#geral");
    expect(html).not.toContain("&lt;#");
  });

  it("resolves old plain-text #geral too", () => {
    const html = renderToStaticMarkup(
      <ChannelRefsProvider serverId={SERVER} channels={channels}>
        <ChannelText text="manda um áudio no #geral dizendo o que achou" />
      </ChannelRefsProvider>,
    );
    expect(html).toContain(`/channel/${GERAL}"`);
  });

  it("shows a neutral, unlinked marker for a channel the viewer cannot see", () => {
    const html = renderToStaticMarkup(
      <ChannelRefsProvider serverId={SERVER} channels={channels}>
        <ChannelText text={`veja <#${SECRET}>`} />
      </ChannelRefsProvider>,
    );
    expect(html).toContain('data-home-channel-ref="unavailable"');
    expect(html).toContain("#unavailable-channel");
    expect(html).not.toContain("<a ");
    // The id is not a name and does not reach the page either.
    expect(html).not.toContain(SECRET);
  });

  it("opens the channel in-app on a plain click and leaves modified clicks to the browser", async () => {
    const onOpenChannel = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <ChannelRefsProvider
          serverId={SERVER}
          channels={channels}
          onOpenChannel={onOpenChannel}
        >
          <ChannelText text={`<#${VOZ}>`} />
        </ChannelRefsProvider>,
      );
    });
    const link = host.querySelector("a")!;
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      link.dispatchEvent(plain);
    });
    expect(onOpenChannel).toHaveBeenCalledWith(VOZ);
    expect(plain.defaultPrevented).toBe(true);

    // Observe from above React, then cancel so jsdom does not "navigate".
    let preventedByApp: boolean | null = null;
    const observe = (event: Event) => {
      preventedByApp = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", observe);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    await act(async () => {
      link.dispatchEvent(modified);
    });
    document.removeEventListener("click", observe);
    expect(onOpenChannel).toHaveBeenCalledTimes(1);
    expect(preventedByApp).toBe(false);
  });
});

describe("PostCard", () => {
  const author: PublicUser = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    displayName: "Tues",
    username: "tues",
    tag: "tues#0002",
    avatarUrl: null,
    customStatus: null,
  };

  function post(overrides: Partial<CommunityHomePost>): CommunityHomePost {
    const now = "2026-09-01T12:00:00.000Z";
    return {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      serverId: SERVER,
      author,
      authorBadge: "owner",
      title: "Teste",
      body: null,
      teaser: null,
      visibility: "free",
      status: "published",
      commentsEnabled: true,
      media: null,
      hasMedia: false,
      posterUrl: null,
      locked: false,
      likeCount: 0,
      likedByMe: false,
      commentCount: 0,
      commentTeaser: [],
      pinned: false,
      scheduledAt: null,
      scheduleTimezone: null,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
      translation: null,
      ...overrides,
    };
  }

  it("draws the channel in the body as a link", () => {
    const html = renderToStaticMarkup(
      <ChannelRefsProvider serverId={SERVER} channels={channels}>
        <PostCard
          post={post({ body: `Testa aí e manda um áudio no <#${GERAL}> dizendo o que achou` })}
          me={author}
          locked={false}
          canManageServer={false}
          vipEnabled={false}
        />
      </ChannelRefsProvider>,
    );
    expect(html).toContain(`/channel/${GERAL}"`);
    expect(html).toContain("Testa aí e manda um áudio no ");
  });

  it("a translated body keeps its link and the original toggle keeps the author's", () => {
    const html = renderToStaticMarkup(
      <ChannelRefsProvider serverId={SERVER} channels={channels}>
        <PostCard
          post={post({
            body: `Try it in <#${GERAL}>`,
            translation: {
              lang: "en",
              auto: true,
              sourceLang: "pt",
              original: { title: "Teste", body: `Testa no <#${GERAL}>`, teaser: null },
            },
          })}
          me={author}
          locked={false}
          canManageServer={false}
          vipEnabled={false}
        />
      </ChannelRefsProvider>,
    );
    expect(html).toContain("Try it in ");
    expect(html).toContain(`/channel/${GERAL}"`);
  });
});

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const picker = useChannelPicker({
    value,
    channels,
    onInsert: (next) => setValue(next),
  });
  return (
    <div>
      <textarea
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          picker.syncCaret(event.target);
        }}
        onKeyDown={(event) => picker.handleKeyDown(event)}
      />
      {picker.menu}
      <output data-value>{value}</output>
    </div>
  );
}

async function type(field: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(field: HTMLElement, name: string) {
  return act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

describe("useChannelPicker", () => {
  async function mount() {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    return host.querySelector("textarea")!;
  }

  const options = () =>
    [...host!.querySelectorAll('[role="option"]')].map((el) => el.textContent);
  const value = () => host!.querySelector("[data-value]")!.textContent;

  it("opens on # with the visible channels, filters as you type, and picks with Enter", async () => {
    const field = await mount();
    expect(options()).toEqual([]);

    await type(field, "manda no #");
    expect(options()).toHaveLength(2);

    await type(field, "manda no #vo");
    expect(options()).toEqual(["#sala-de-voz"]);

    await key(field, "Enter");
    expect(value()).toBe("manda no #sala-de-voz ");
    expect(options()).toEqual([]);
  });

  it("walks the list with the arrows and wraps", async () => {
    const field = await mount();
    await type(field, "#");
    await key(field, "ArrowDown");
    await key(field, "Tab");
    expect(value()).toBe("#sala-de-voz ");

    await type(field, "#");
    await key(field, "ArrowUp");
    await key(field, "Enter");
    expect(value()).toBe("#sala-de-voz ");
  });

  it("picks with the mouse", async () => {
    const field = await mount();
    await type(field, "#ge");
    const option = host!.querySelector('[role="option"]')!;
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(value()).toBe("#geral ");
  });

  it("Escape closes it for this token and does not eat the key otherwise", async () => {
    const field = await mount();
    await type(field, "#ge");
    expect(options()).toHaveLength(1);
    await key(field, "Escape");
    expect(options()).toEqual([]);
    // Enter now is a plain newline press, not a pick.
    await key(field, "Enter");
    expect(value()).toBe("#ge");
  });

  it("stays closed when nothing matches", async () => {
    const field = await mount();
    await type(field, "#zzz");
    expect(options()).toEqual([]);
    expect(host!.querySelector('[role="listbox"]')).toBeNull();
  });
});
