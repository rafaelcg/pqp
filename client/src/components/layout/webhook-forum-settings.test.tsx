// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForumTag, WebhookForumSettings } from "@pqp/shared";

/**
 * A forum webhook's feed settings (forum PR 4). Every tick saves the WHOLE
 * settings object (the route replaces all three fields), switching to "only
 * these" starts from every open tag so nothing changes until a tick comes off,
 * a sixth default tag cannot be ticked, and a refused save puts the ticks back
 * to what the server still holds.
 */

const { putMock } = vi.hoisted(() => ({ putMock: vi.fn() }));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    putWebhookForumSettings: (...args: unknown[]) => putMock(...args),
  };
});

const { WebhookForumSettingsPanel } = await import("./webhook-forum-settings");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  putMock.mockReset();
});

function tag(id: string, name: string, moderated = false): ForumTag {
  return { id, name, emoji: null, moderated, position: 0, postCount: 0 };
}

const TAGS = [
  tag("t1", "Notícias"),
  tag("t2", "Lançamento"),
  tag("t3", "Oficial", true),
  tag("t4", "Dúvida"),
  tag("t5", "Bug"),
  tag("t6", "Guia"),
];

const DEFAULTS: WebhookForumSettings = {
  allowedTagIds: null,
  defaultTagIds: [],
  dedupeWindowHours: 72,
};

function render(initial: WebhookForumSettings = DEFAULTS, tags = TAGS) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(<WebhookForumSettingsPanel webhookId="w1" initial={initial} tags={tags} />),
  );
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  act(() => toggle.click());
  return host;
}

function radio(scope: HTMLElement, label: string): HTMLButtonElement {
  return [...scope.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (node) => node.textContent?.trim() === label,
  )!;
}

function groupChecks(scope: HTMLElement, groupLabel: string): HTMLButtonElement[] {
  const group = [...scope.querySelectorAll<HTMLElement>('[role="group"]')].find(
    (node) => node.getAttribute("aria-label") === groupLabel,
  )!;
  return [...group.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WebhookForumSettingsPanel", () => {
  it("is folded until opened", () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root!.render(<WebhookForumSettingsPanel webhookId="w1" initial={DEFAULTS} tags={TAGS} />),
    );
    const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("'only the ones I tick' starts from every open tag, and a tick saves the whole object", async () => {
    putMock.mockResolvedValue({ settings: DEFAULTS });
    const scope = render();
    act(() => radio(scope, "Only the ones I tick").click());
    await flush();
    expect(putMock).toHaveBeenLastCalledWith("w1", {
      allowedTagIds: ["t1", "t2", "t4", "t5", "t6"],
      defaultTagIds: [],
      dedupeWindowHours: 72,
    });

    const allowed = groupChecks(scope, "Only the ones I tick");
    // Oficial is staff only: unticked, and says so.
    expect(allowed[2]!.getAttribute("aria-checked")).toBe("false");
    expect(allowed[2]!.textContent).toContain("Staff only");
    act(() => allowed[2]!.click());
    await flush();
    expect(putMock).toHaveBeenLastCalledWith("w1", {
      allowedTagIds: ["t1", "t2", "t3", "t4", "t5", "t6"],
      defaultTagIds: [],
      dedupeWindowHours: 72,
    });
  });

  it("caps the default tags at five", () => {
    putMock.mockResolvedValue({});
    const scope = render({ ...DEFAULTS, defaultTagIds: ["t1", "t2", "t3", "t4", "t5"] });
    const defaults = groupChecks(scope, "Default tags");
    expect(defaults[5]!.disabled).toBe(true);
    expect(defaults[0]!.disabled).toBe(false);
  });

  it("the dedupe window saves, and a refused save puts the old value back", async () => {
    putMock.mockRejectedValueOnce(new Error("nope"));
    const scope = render();
    act(() => radio(scope, "Off").click());
    await flush();
    expect(putMock).toHaveBeenLastCalledWith("w1", { ...DEFAULTS, dedupeWindowHours: 0 });
    expect(radio(scope, "72 h").getAttribute("aria-checked")).toBe("true");
    expect(scope.textContent).toContain("nope");
  });

  it("an older edit failing never rolls back a newer one", async () => {
    let failFirst!: (error: Error) => void;
    putMock
      .mockImplementationOnce(
        () => new Promise((_, reject) => {
          failFirst = reject;
        }),
      )
      .mockResolvedValueOnce({});
    const scope = render();
    act(() => radio(scope, "24 h").click());
    act(() => radio(scope, "7 days").click());
    await act(async () => failFirst(new Error("nope")));
    await flush();
    await flush();
    // The newest edit is still on screen, and it is what went out last.
    expect(radio(scope, "7 days").getAttribute("aria-checked")).toBe("true");
    expect(putMock).toHaveBeenLastCalledWith("w1", { ...DEFAULTS, dedupeWindowHours: 168 });
  });

  it("a window set elsewhere stays visible as its own option", () => {
    const scope = render({ ...DEFAULTS, dedupeWindowHours: 48 });
    expect(radio(scope, "48 h").getAttribute("aria-checked")).toBe("true");
  });

  it("a forum with no tags shows only the dedupe window", () => {
    const scope = render(DEFAULTS, []);
    expect(scope.textContent).toContain("This forum has no tags yet");
    expect(scope.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);
  });
});
