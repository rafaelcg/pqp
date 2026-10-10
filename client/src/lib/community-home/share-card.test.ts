import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchCard = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchCommunityHomePostCard: (...args: unknown[]) => fetchCard(...args),
}));

const {
  __resetBauCardCache,
  isOwnInstanceOrigin,
  loadBauCard,
  selectBauCardLink,
  stripBauLink,
} = await import("./share-card");

const SERVER = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab";
const POST = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";
const PATH = `/app/server/${SERVER}/bau/${POST}`;
const CARD = { postId: POST, serverId: SERVER, title: "t" };

describe("isOwnInstanceOrigin", () => {
  it("trusts the running origin and the hosted app, nothing else", () => {
    expect(isOwnInstanceOrigin("http://localhost:5173", "http://localhost:5173")).toBe(true);
    expect(isOwnInstanceOrigin("https://pqp.gg", null)).toBe(true);
    expect(isOwnInstanceOrigin("https://www.pqp.gg", "http://localhost:5173")).toBe(true);
    expect(isOwnInstanceOrigin("http://pqp.gg", null)).toBe(false);
    expect(isOwnInstanceOrigin("https://pqp.gg.evil.example", null)).toBe(false);
    expect(isOwnInstanceOrigin("https://other.example", "https://pqp.gg")).toBe(false);
  });
});

describe("selectBauCardLink", () => {
  it("picks the first trusted link and says when it is the whole message", () => {
    const bare = selectBauCardLink(`https://pqp.gg${PATH}`, null);
    expect(bare?.link.postId).toBe(POST);
    expect(bare?.linkOnly).toBe(true);

    const noted = selectBauCardLink(`Saiu! https://pqp.gg${PATH} corre`, null);
    expect(noted?.linkOnly).toBe(false);
  });

  it("skips a foreign instance and takes the next link that is ours", () => {
    const text = `https://other.example${PATH} https://pqp.gg${PATH}`;
    const picked = selectBauCardLink(text, null);
    expect(picked?.link.origin).toBe("https://pqp.gg");
    expect(selectBauCardLink(`https://other.example${PATH}`, null)).toBeNull();
  });

  it("gives plain messages no card", () => {
    expect(selectBauCardLink("oi", null)).toBeNull();
    expect(selectBauCardLink(null, null)).toBeNull();
    expect(selectBauCardLink(`https://pqp.gg/app/server/${SERVER}/bau`, null)).toBeNull();
  });
});

describe("stripBauLink", () => {
  it("keeps the sender's words and drops the url", () => {
    const body = `Saiu clip novo!\nhttps://pqp.gg${PATH}`;
    const link = selectBauCardLink(body, null)!.link;
    expect(stripBauLink(body, link)).toBe("Saiu clip novo!");
    const inline = `olha https://pqp.gg${PATH} corre`;
    expect(stripBauLink(inline, selectBauCardLink(inline, null)!.link)).toBe("olha  corre");
    const bare = `https://pqp.gg${PATH}`;
    expect(stripBauLink(bare, selectBauCardLink(bare, null)!.link)).toBe("");
  });
});

describe("loadBauCard", () => {
  beforeEach(() => {
    __resetBauCardCache();
    fetchCard.mockReset();
  });

  it("asks once for the same post however many rows render it", async () => {
    fetchCard.mockResolvedValue({ card: CARD });
    const [a, b] = await Promise.all([
      loadBauCard(SERVER, POST, "en"),
      loadBauCard(SERVER, POST, "en"),
    ]);
    expect(a).toEqual(CARD);
    expect(b).toEqual(CARD);
    expect(fetchCard).toHaveBeenCalledTimes(1);
  });

  it("a refusal is null (the link stays plain) and is cached briefly", async () => {
    fetchCard.mockRejectedValue(new Error("404"));
    let now = 1000;
    expect(await loadBauCard(SERVER, POST, "en", () => now)).toBeNull();
    now += 10_000;
    expect(await loadBauCard(SERVER, POST, "en", () => now)).toBeNull();
    expect(fetchCard).toHaveBeenCalledTimes(1);
    now += 60_000;
    fetchCard.mockResolvedValue({ card: CARD });
    expect(await loadBauCard(SERVER, POST, "en", () => now)).toEqual(CARD);
    expect(fetchCard).toHaveBeenCalledTimes(2);
  });
});
