// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscordImportNotice,
  resetDiscordImportNoticeViewsForTests,
} from "./discord-import-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const events: Array<[string, unknown]> = [];
vi.mock("@/lib/track", () => ({
  track: (name: string, data?: unknown) => {
    events.push([name, data]);
  },
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

beforeEach(() => {
  events.length = 0;
  resetDiscordImportNoticeViewsForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const noop = () => {};

describe("DiscordImportNotice", () => {
  it("says what it does, in few words, and promises nothing is deleted", () => {
    const html = renderToStaticMarkup(
      <DiscordImportNotice serverId="s1" existing={false} onImport={noop} onDismiss={noop} />,
    );
    expect(html).toContain("Coming from Discord? Bring your server over");
    expect(html).toContain("Nothing gets deleted, here or on your Discord.");
    expect(html).toContain("Import from Discord");
    // It copies the layout, so it must not promise members or messages.
    expect(html).not.toMatch(/members|messages/i);
  });

  it("is a labelled region named by its title, with one action and a named close", () => {
    const html = renderToStaticMarkup(
      <DiscordImportNotice serverId="s1" existing={false} onImport={noop} onDismiss={noop} />,
    );
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html).toContain('aria-label="Dismiss"');
    expect(html.match(/data-discord-import-notice-action/g)).toHaveLength(1);
    // Not a live region: a standing offer must not be announced on every switch.
    expect(html).not.toContain("role=");
  });

  it("the button imports and is tracked, the X dismisses and is tracked", async () => {
    const onImport = vi.fn();
    const onDismiss = vi.fn();
    const el = await mount(
      <DiscordImportNotice serverId="s1" existing={false} onImport={onImport} onDismiss={onDismiss} />,
    );
    const action = el.querySelector<HTMLButtonElement>("[data-discord-import-notice-action]")!;
    const close = el.querySelector<HTMLButtonElement>("[data-discord-import-notice-close]")!;
    await act(async () => action.click());
    expect(onImport).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => close.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(events.map(([name]) => name)).toEqual([
      "discord_import_notice_view",
      "discord_import_notice_click",
      "discord_import_notice_dismiss",
    ]);
  });

  it("counts one view per server per load, even if it is handed back", async () => {
    await mount(
      <DiscordImportNotice serverId="s1" existing={false} onImport={noop} onDismiss={noop} />,
    );
    act(() => root?.unmount());
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <DiscordImportNotice serverId="s1" existing={false} onImport={noop} onDismiss={noop} />,
      );
    });
    expect(events.filter(([name]) => name === "discord_import_notice_view")).toHaveLength(1);
  });
});
