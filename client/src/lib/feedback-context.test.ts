import { describe, expect, it } from "vitest";
import { feedbackContextSchema } from "@pqp/shared";
import { buildFeedbackContext } from "./feedback-context";

describe("buildFeedbackContext", () => {
  it("builds a context the server schema accepts", () => {
    const context = buildFeedbackContext(
      { inCall: true, transport: "livekit", watchParty: true },
      { appVersion: "4718c63", locale: "pt-BR" },
    );
    expect(context).toMatchObject({
      platform: "web",
      appVersion: "4718c63",
      locale: "pt-BR",
      voice: { inCall: true, transport: "livekit", watchParty: true },
    });
    expect(feedbackContextSchema.safeParse(context).success).toBe(true);
  });

  it("does not claim a transport or a party for somebody not in a call", () => {
    const context = buildFeedbackContext(
      { inCall: false, transport: "mesh", watchParty: true },
      { appVersion: "" },
    );
    expect(context.voice).toEqual({ inCall: false, transport: null, watchParty: false });
    expect(context.appVersion).toBe("dev");
  });
});
