// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Invite } from "@pqp/shared";
import { ServerReadyPanel } from "./server-ready-panel";

const invite: Invite = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "jrlyZjQ",
  serverId: "22222222-2222-4222-8222-222222222222",
  maxUses: null,
  uses: 0,
  expiresAt: null,
  createdAt: "2026-10-08T00:00:00.000Z",
};

describe("ServerReadyPanel", () => {
  it("offers the short and long pastes under the link by default", () => {
    const html = renderToStaticMarkup(
      <ServerReadyPanel invite={invite} inviteRef="convite" onRetry={() => {}} />,
    );
    expect(html).toContain("data-copy-invite-link");
    expect(html).toContain("data-invite-paste");
  });

  it("drops them when the caller has its own message (the Discord import)", () => {
    const html = renderToStaticMarkup(
      <ServerReadyPanel
        invite={invite}
        inviteRef="discord"
        showPastes={false}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("data-copy-invite-link");
    expect(html).not.toContain("data-invite-paste");
  });
});
