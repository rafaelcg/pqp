import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createForwardSchema, messageSchema } from "@pqp/shared";
import { describe, expect, it } from "vitest";

/**
 * ENCAMINHAR, THE TWO HALVES COMPARED (the lesson of
 * `server/src/lib/flag-client-contract.test.ts`, from this side): the config
 * route the server serves and the one this client reads, the request this
 * client sends and the schema the server parses, and the places in the app
 * that have to be wired for the action to exist at all.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");

const ID = "11111111-1111-4111-8111-111111111111";

describe("the flag", () => {
  it("is served on GET /api/forwards/config as `enabled`, from the flag of that name", () => {
    const api = read("server/src/api/index.ts");
    const route = /router\.get\("\/api\/forwards\/config"[\s\S]*?\)\);/.exec(api)?.[0];
    expect(route, "GET /api/forwards/config is not mounted").toBeTruthy();
    expect(route).toContain("enabled: forwardMessagesEnabled()");
    expect(read("server/src/services/forwards.ts")).toContain('isEnabled("forward_messages")');
    expect(read("server/src/lib/flags.ts")).toContain('clientVia: "GET /api/forwards/config"');
  });

  it("is read by this client off that route, asked again on refresh, and started by the app", () => {
    expect(read("client/src/lib/api.ts")).toContain('"/api/forwards/config"');
    const lib = read("client/src/lib/forward.ts");
    expect(lib).toMatch(/answer\.enabled === true/);
    expect(lib).toContain("onConfigRefresh(");
    expect(read("client/src/App.tsx")).toMatch(/startForwardConfig\(\)/);
  });
});

describe("the wire", () => {
  it("the request the picker builds is one the server parses", () => {
    const post = createForwardSchema.safeParse({
      source: { kind: "bau_post", id: ID, serverId: ID },
      targets: [{ channelId: ID }],
      comment: "olha",
      nonce: "n-1",
    });
    expect(post.success).toBe(true);
    const message = createForwardSchema.safeParse({
      source: { kind: "message", id: ID },
      targets: [{ channelId: ID }],
    });
    expect(message.success).toBe(true);
    // Reads the same shapes the picker file builds.
    const picker = read("client/src/components/forward/forward-picker.tsx");
    expect(picker).toContain('{ kind: "bau_post", id: source.id, serverId: source.serverId }');
    expect(picker).toContain('{ kind: "message", id: source.id }');
  });

  it("a forward rides on the message the client parses, and is absent on an ordinary one", () => {
    const base = {
      id: ID,
      channelId: ID,
      authorId: ID,
      authorName: "a",
      authorTag: null,
      authorAvatarUrl: null,
      body: "oi",
      createdAt: "2026-10-15T12:00:00.000Z",
    };
    expect(messageSchema.parse(base).forward).toBeUndefined();
  });
});

describe("the places the action has to be wired", () => {
  it("the message menu, the Baú card and the toast all go through the app", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain("onForward={requestForward}");
    expect(app).toContain("onForwardPost={forwardEnabled ? requestForwardPost : undefined}");
    expect(app).toContain("<ForwardPicker");
    expect(app).toContain("<ForwardedToast");
    const feed = read("client/src/components/community-home/community-home-feed.tsx");
    expect(feed).toContain("data-home-forward");
    const list = read("client/src/components/chat/message-list.tsx");
    expect(list).toContain("<ForwardCard");
  });
});
