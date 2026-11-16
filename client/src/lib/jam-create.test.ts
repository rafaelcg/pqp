import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { createJamOnce } from "./jam-create";

type Ch = { id: string; type: string };
const jam = (id: string): Ch => ({ id, type: "jam" });
const known = new Set(["text-1"]);

describe("making a Jam channel without making two", () => {
  it("creates once when nothing goes wrong", async () => {
    let created = 0;
    const result = await createJamOnce<Ch>({
      known,
      unsure: null,
      create: async () => (created++, jam("j1")),
      list: async () => [],
    });
    expect(result.channel?.id).toBe("j1");
    expect(created).toBe(1);
  });

  it("takes a channel that landed with a lost reply as the answer, and does not create again", async () => {
    let created = 0;
    const result = await createJamOnce<Ch>({
      known,
      unsure: null,
      create: async () => {
        created++;
        throw new TypeError("Failed to fetch");
      },
      list: async () => [jam("landed")],
    });
    expect(result.channel?.id).toBe("landed");
    expect(created).toBe(1);
  });

  it("a plain refusal is a refusal: no list read, nothing unsure", async () => {
    let listed = 0;
    const result = await createJamOnce<Ch>({
      known,
      unsure: null,
      create: async () => {
        throw new ApiError(403, "jam_channels_off");
      },
      list: async () => (listed++, []),
    });
    expect(result.channel).toBeNull();
    expect(result.unsure).toBeNull();
    expect(listed).toBe(0);
  });

  it("keeps the baseline when the list cannot be read, and the next call settles BEFORE creating", async () => {
    let created = 0;
    const first = await createJamOnce<Ch>({
      known,
      unsure: null,
      create: async () => {
        created++;
        throw new TypeError("Failed to fetch");
      },
      list: async () => {
        throw new Error("offline");
      },
    });
    expect(first.unsure).toEqual(known);
    expect(first.channel).toBeNull();

    // the retry: the list is readable now and shows the channel the first attempt made
    const second = await createJamOnce<Ch>({
      known: new Set(["text-1", "something-else-the-screen-learned"]),
      unsure: first.unsure,
      create: async () => (created++, jam("second")),
      list: async () => [jam("landed")],
    });
    expect(second.channel?.id).toBe("landed");
    expect(created).toBe(1); // never a second create
  });

  it("while the list is still unreadable, the retry creates nothing", async () => {
    let created = 0;
    const result = await createJamOnce<Ch>({
      known,
      unsure: known,
      create: async () => (created++, jam("x")),
      list: async () => {
        throw new Error("offline");
      },
    });
    expect(result.failure).toBe("unreadable");
    expect(result.unsure).toEqual(known);
    expect(created).toBe(0);
  });

  it("creates after settling when the list shows the earlier attempt did not land", async () => {
    let created = 0;
    const result = await createJamOnce<Ch>({
      known,
      unsure: known,
      create: async () => (created++, jam("fresh")),
      list: async () => [],
    });
    expect(result.channel?.id).toBe("fresh");
    expect(created).toBe(1);
  });
});
