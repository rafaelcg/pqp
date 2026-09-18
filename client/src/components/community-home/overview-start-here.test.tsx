import type { Channel } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewStartHere } from "./overview-start-here";

function channel(
  overrides: Partial<Channel> & Pick<Channel, "id" | "name" | "type">,
): Channel {
  return {
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    position: 0,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    parentId: null,
    slowmodeSeconds: 0,
    voiceTransport: null,
    ...overrides,
  };
}

const avisos = channel({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  name: "avisos",
  type: "text",
  position: 1,
});
const ajuda = channel({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  name: "ajuda",
  type: "text",
  position: 2,
  topic: "manda o print",
});
const geral = channel({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
  name: "geral",
  type: "text",
  position: 3,
});

describe("OverviewStartHere", () => {
  it("renders QG defaults with a topic winning over the hint", () => {
    const html = renderToStaticMarkup(
      <OverviewStartHere
        serverId="11111111-1111-4111-8111-111111111111"
        channels={[avisos, ajuda, geral]}
        onOpenChannel={() => {}}
      />,
    );
    expect(html).toContain("data-overview-start-here");
    expect(html).toContain("Start here");
    expect(html).toContain("#avisos");
    expect(html).toContain("Read this first.");
    expect(html).toContain("manda o print");
    expect(html).not.toContain("Bugs, login");
    expect(html).toContain("#geral");
    expect(html).not.toContain("data-overview-start-here-pick");
  });

  it("shows the picker for staff who are editing the page", () => {
    const html = renderToStaticMarkup(
      <OverviewStartHere
        serverId="11111111-1111-4111-8111-111111111111"
        channels={[avisos, ajuda, geral]}
        editing
        canManageServer
        onOpenChannel={() => {}}
      />,
    );
    expect(html).toContain("data-overview-start-here-pick");
    expect(html).toContain("Channels on Overview");
    expect(html).toContain("data-overview-pick");
  });
});
