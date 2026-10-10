import { describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import { pickAnnounceChannel, shareableChannels } from "./announce";

let n = 0;
function channel(
  name: string,
  over: Partial<Channel> = {},
): Channel {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    serverId: "11111111-1111-4111-8111-111111111111",
    kind: "server",
    name,
    type: "text",
    position: n,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    parentId: null,
    slowmodeSeconds: 0,
    ...over,
  } as Channel;
}

describe("shareableChannels", () => {
  it("keeps text channels the caller can speak in, in order", () => {
    const a = channel("avisos");
    const voice = channel("sala", { type: "voice" });
    const cat = channel("cat", { type: "category" });
    const b = channel("geral");
    const muted = channel("so-leitura");
    const result = shareableChannels([b, voice, cat, a, muted], (id) => id !== muted.id);
    expect(result.map((c) => c.name)).toEqual(["avisos", "geral"]);
  });
});

describe("pickAnnounceChannel", () => {
  it("prefers the general room whatever it is called", () => {
    const first = channel("avisos");
    const general = channel("💬・Geral");
    expect(pickAnnounceChannel([first, general])?.id).toBe(general.id);
    const english = channel("general");
    expect(pickAnnounceChannel([first, english])?.id).toBe(english.id);
  });

  it("falls back to the first public text channel, then to any", () => {
    const secret = channel("staff", { isPrivate: true });
    const open = channel("memes");
    expect(pickAnnounceChannel([secret, open])?.id).toBe(open.id);
    expect(pickAnnounceChannel([secret])?.id).toBe(secret.id);
  });

  it("is null when there is nowhere to speak", () => {
    expect(pickAnnounceChannel([channel("a")], () => false)).toBeNull();
    expect(pickAnnounceChannel([])).toBeNull();
  });
});
