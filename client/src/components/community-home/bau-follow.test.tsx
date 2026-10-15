import type { BauFollow, BauFollowState } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelBauFollowsSection } from "@/components/layout/channel-bau-follows-section";
import { ApiError } from "@/lib/api";
import { BauFollowButton, bauFollowErrorKey } from "./bau-follow";

const follow = (over: Partial<BauFollow> = {}): BauFollow => ({
  id: "11111111-1111-4111-8111-111111111111",
  sourceServerId: "22222222-2222-4222-8222-222222222222",
  sourceServerName: "QG",
  sourceServerIconUrl: null,
  targetServerId: "33333333-3333-4333-8333-333333333333",
  targetServerName: "Galera",
  targetChannelId: "44444444-4444-4444-8444-444444444444",
  targetChannelName: "avisos",
  rolePingId: null,
  rolePingName: null,
  status: "active",
  pausedReason: null,
  pausedAt: null,
  createdAt: "2026-10-15T12:00:00.000Z",
  mine: true,
  ...over,
});

const state = (over: Partial<BauFollowState> = {}): BauFollowState => ({
  enabled: true,
  maxPerServer: 20,
  mine: [],
  ...over,
});

describe("BauFollowButton", () => {
  it("is not drawn while the flag is off for this Baú, or the read failed", () => {
    expect(
      renderToStaticMarkup(<BauFollowButton state={state({ enabled: false })} onOpen={() => {}} />),
    ).toBe("");
    expect(renderToStaticMarkup(<BauFollowButton state={null} onOpen={() => {}} />)).toBe("");
  });

  it("says Follow, then Following once the viewer follows it somewhere", () => {
    const fresh = renderToStaticMarkup(<BauFollowButton state={state()} onOpen={() => {}} />);
    expect(fresh).toContain("data-bau-follow-button");
    expect(fresh).toContain('data-following="0"');
    expect(fresh).toContain("Follow");
    const following = renderToStaticMarkup(
      <BauFollowButton state={state({ mine: [follow()] })} onOpen={() => {}} />,
    );
    expect(following).toContain('data-following="1"');
    expect(following).toContain("Following");
  });
});

describe("bauFollowErrorKey", () => {
  it("names each refusal the API gives", () => {
    expect(bauFollowErrorKey(new ApiError(429, "Slow down"))).toBe("bauFollow.error.slow");
    expect(bauFollowErrorKey(new ApiError(403, "You need to manage webhooks or channels in that channel"))).toBe(
      "bauFollow.error.forbidden",
    );
    expect(bauFollowErrorKey(new ApiError(403, "This Baú does not accept that server"))).toBe(
      "bauFollow.error.blocked",
    );
    expect(bauFollowErrorKey(new ApiError(409, "That channel already follows this Baú"))).toBe(
      "bauFollow.error.exists",
    );
    expect(bauFollowErrorKey(new ApiError(409, "A server can follow at most 20 Baús"))).toBe(
      "bauFollow.error.limit",
    );
    expect(bauFollowErrorKey(new ApiError(400, "That role cannot be pinged"))).toBe(
      "bauFollow.error.invalid",
    );
    expect(bauFollowErrorKey(new Error("offline"))).toBe("bauFollow.error.generic");
  });
});

describe("ChannelBauFollowsSection", () => {
  it("lists what the channel follows with Unfollow, and Resume on a paused one", () => {
    const html = renderToStaticMarkup(
      <ChannelBauFollowsSection
        follows={[
          follow(),
          follow({
            id: "55555555-5555-4555-8555-555555555555",
            sourceServerName: "Outra",
            status: "paused",
            pausedReason: "permissions",
            pausedAt: "2026-10-15T13:00:00.000Z",
          }),
        ]}
        onChange={() => {}}
      />,
    );
    expect(html).toContain("Baú of QG");
    expect(html).toContain("Baú of Outra");
    expect((html.match(/data-channel-bau-follow-unfollow/g) ?? []).length).toBe(2);
    expect((html.match(/data-channel-bau-follow-resume/g) ?? []).length).toBe(1);
    expect(html).toContain("Paused");
    expect(html).not.toContain("Mentions");
  });
});

describe("ChannelBauFollowsSection when the read failed", () => {
  it("says so and offers a retry instead of vanishing", () => {
    const html = renderToStaticMarkup(
      <ChannelBauFollowsSection follows={[]} onChange={() => {}} failed onRetry={() => {}} />,
    );
    expect(html).toContain("Could not load what this channel follows.");
    expect(html).toContain("Retry");
  });
});

describe("a pause says why", () => {
  it("names a ban as a ban, not as a lost permission", () => {
    const paused = (reason: "permissions" | "banned") =>
      renderToStaticMarkup(
        <ChannelBauFollowsSection
          follows={[follow({ status: "paused", pausedReason: reason, pausedAt: "2026-10-15T13:00:00.000Z" })]}
          onChange={() => {}}
        />,
      );
    expect(paused("banned")).toContain("banned the Baú");
    expect(paused("banned")).not.toContain("lost permission");
    expect(paused("permissions")).toContain("lost permission");
  });
});
