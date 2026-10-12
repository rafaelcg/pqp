import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatClientMessageSchema, chatServerMessageSchema } from "@pqp/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sounds", () => ({ playCue: () => {} }));
vi.mock("@/lib/preferences", () => ({ queuePreferenceSync: () => {} }));

const { sendNudge, resetNudgeStateForTests } = await import("./nudge");

/**
 * CHAMAR A ATENÇÃO, THE TWO HALVES COMPARED (the lesson of
 * `server/src/lib/flag-client-contract.test.ts`, from this side): the field
 * the server serves and the field this client reads, the frame this client
 * sends and the frame the server parses, and the places in the app that have
 * to be wired for any of it to happen. Each side's own tests prove only that
 * side.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");

describe("the nudge flag", () => {
  it("is served on GET /api/fun/config as `nudge`, from the flag of that name", () => {
    const api = read("server/src/api/index.ts");
    const route = /router\.get\("\/api\/fun\/config"[\s\S]*?\);/.exec(api)?.[0];
    expect(route, "GET /api/fun/config is not mounted").toBeTruthy();
    expect(route).toContain('nudge: isEnabled("nudge")');
    expect(read("server/src/lib/flags.ts")).toContain('clientVia: "GET /api/fun/config (nudge)"');
  });

  it("is read by this client off that route, and asked for again on refresh", () => {
    const lib = read("client/src/lib/nudge.ts");
    expect(lib).toContain('"/api/fun/config"');
    expect(lib).toMatch(/answer\.nudge === true/);
    expect(lib).toContain("onConfigRefresh(");
    expect(read("client/src/App.tsx")).toMatch(/startFunConfig\(\)/);
  });
});

describe("the wire", () => {
  it("the frame the button sends is one the server parses", () => {
    resetNudgeStateForTests();
    const frames: unknown[] = [];
    sendNudge("11111111-1111-4111-8111-111111111111", {
      send: (frame) => frames.push(frame),
      connected: true,
    });
    expect(frames).toHaveLength(1);
    expect(chatClientMessageSchema.safeParse(frames[0]).success).toBe(true);
  });

  it("the refusal and the nudge message are frames this client routes", () => {
    expect(
      chatServerMessageSchema.safeParse({
        type: "nudge-refused",
        channelId: "11111111-1111-4111-8111-111111111111",
        reason: "busy",
      }).success,
    ).toBe(true);
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/message\.type === "nudge-refused"\) \{\s*handleNudgeRefused\(message\)/);
    expect(app).toMatch(/message\.message\.systemKind === "nudge"/);
    expect(app).toContain("applyNudgeArrival(message.message");
    expect(app).toContain("systemKind: activity.systemKind");
    expect(app).toContain("adoptAllowNudges(me.preferences)");
  });

  it("the pane that shows a conversation carries the shake", () => {
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/<FileDropZone\s+\{\.\.\.nudgeShake\}/);
  });

  it("Modo 2005's window toolbar, which replaces the header, still nudges", () => {
    const app = read("client/src/App.tsx");
    expect(app).toMatch(/onNudge=\{retroNudge \?/);
    expect(app).toMatch(/useNudgeTrigger\(\s*retroOn \? nudgeChannelId : null/);
  });
});
