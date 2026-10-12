import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { StoryStrip as StoryStripData, StoryStripItem } from "@pqp/shared";
import { primeStoryStripCache, resetStoryStripCache } from "@/lib/stories/use-story-strip";
import { StoryStrip } from "./story-strip";

const SERVER = "11111111-1111-4111-8111-111111111111";
const me = { id: "22222222-2222-4222-8222-222222222222", displayName: "Rafa", avatarUrl: null };
const audience = { kind: "server", serverId: SERVER, serverName: "QG do pqp" } as const;

function item(name: string, unseen: boolean, hasCall = false): StoryStripItem {
  return {
    author: { id: `${name}-id`, displayName: name, avatarUrl: null, handle: null },
    storyIds: [`${name}-1`],
    latestAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    unseen,
    hasCall,
  };
}

function render(strip: StoryStripData): string {
  primeStoryStripCache({ kind: "server", serverId: SERVER }, strip, me.id);
  return renderToStaticMarkup(<StoryStrip audience={audience} me={me} />);
}

const base: StoryStripData = { enabled: true, canPost: true, own: null, items: [], firstRunHint: false };

afterEach(() => resetStoryStripCache());

describe("StoryStrip", () => {
  it("flag off: draws nothing", () => {
    expect(render({ ...base, enabled: false, items: [item("Bia", true)] })).toBe("");
  });

  it("nothing live and no first run: draws nothing, not an empty row", () => {
    expect(render(base)).toBe("");
  });

  it("first run with no storage to remember a dismissal: stays quiet (lib/hints rule)", () => {
    // A row that cannot remember being closed would come back on every
    // navigation, so `isHintSeen` reads missing storage as seen. When it
    // does show is `stripView`'s job, pinned in strip-state.test.ts.
    expect(render({ ...base, firstRunHint: true })).toBe("");
  });

  it("rings in the server's order, own first, seen and call states labelled", () => {
    const html = render({
      ...base,
      items: [item("Bia", true), item("Fe", true, true), item("Andre", false)],
    });
    expect(html).toContain("data-story-strip");
    const order = [...html.matchAll(/data-story-ring="server:[^:]+:([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["own", "Bia-id", "Fe-id", "Andre-id"]);
    expect(html).toContain("Bia&#x27;s story, new");
    expect(html).toContain("Fe&#x27;s story, with a call");
    expect(html).toContain("Andre&#x27;s story, seen");
    expect(html).toContain("Your story, post");
  });

  it("an author who may not post gets no own ring", () => {
    const html = render({ ...base, canPost: false, items: [item("Bia", true)] });
    expect(html).not.toContain(":own");
  });

  it("expired rings are dropped locally", () => {
    const expired = { ...item("Old", true), expiresAt: new Date(Date.now() - 1_000).toISOString() };
    expect(render({ ...base, items: [expired] })).toBe("");
  });
});
