import { describe, expect, it } from "vitest";
import { siteLinkLabel } from "./community-official-links";

describe("siteLinkLabel", () => {
  it("shows the host without www", () => {
    expect(siteLinkLabel("https://www.pqp.gg/")).toBe("pqp.gg");
  });

  it("keeps the path so two links on one site stay apart", () => {
    expect(siteLinkLabel("https://pqp.gg/download")).toBe("pqp.gg/download");
    expect(siteLinkLabel("https://github.com/rafaelcg/pqp")).toBe("github.com/rafaelcg/pqp");
  });

  it("cuts a long address short", () => {
    const label = siteLinkLabel("https://example.com/a/very/long/path/that/keeps/going")!;
    expect(label.length).toBe(28);
    expect(label.endsWith("…")).toBe(true);
  });

  it("gives up on something that is not a URL", () => {
    expect(siteLinkLabel("not a url")).toBeNull();
  });
});
