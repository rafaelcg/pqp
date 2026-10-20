import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App.tsx cannot be rendered in a unit test, so this pins the one thing the
 * review found it getting wrong: `app-session` and `app-error` are what end a
 * join, so the branch of the socket handler that stops apps frames must hand
 * them to the store's `handleAppsFrame` before it returns, and no other branch
 * may name them first. The store's own behaviour is covered in
 * app-sessions-store.test.ts.
 */
describe("the shell routes apps frames through the store", () => {
  const source = readFileSync(resolve(__dirname, "../../App.tsx"), "utf8");
  const types = ["channel-app", "app-ended", "app-session", "app-state", "app-event", "app-error"];

  it("names every apps frame in one branch, and that branch calls the store before returning", () => {
    const first = source.indexOf('message.type === "app-session"');
    expect(first).toBeGreaterThan(-1);
    const branchEnd = source.indexOf("return;", first);
    const branch = source.slice(source.lastIndexOf("if (", first), branchEnd);
    for (const type of types) {
      expect(branch, `${type} missing from the apps branch`).toContain(
        `message.type === "${type}"`,
      );
    }
    expect(branch).toContain("handleAppsFrame(message);");
  });

  it("has no other stop that names a join answer by type", () => {
    for (const type of types) {
      const needle = `message.type === "${type}"`;
      expect(source.split(needle).length - 1, `${type} is named more than once`).toBe(1);
    }
  });
});
