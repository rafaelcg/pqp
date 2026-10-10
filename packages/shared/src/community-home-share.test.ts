import { describe, expect, it } from "vitest";
import {
  bauPostPath,
  bodyIsOnlyBauLink,
  findBauPostLinks,
  parseBauPostPath,
} from "./community-home-share.js";

const SERVER = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab";
const POST = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";
const PATH = `/app/server/${SERVER}/bau/${POST}`;

describe("bauPostPath / parseBauPostPath", () => {
  it("round-trips", () => {
    expect(bauPostPath(SERVER, POST)).toBe(PATH);
    expect(parseBauPostPath(PATH)).toEqual({ serverId: SERVER, postId: POST });
    expect(parseBauPostPath(`${PATH}/`)).toEqual({ serverId: SERVER, postId: POST });
  });

  it("lowercases ids so a shouted link still matches the row", () => {
    expect(
      parseBauPostPath(`/app/server/${SERVER.toUpperCase()}/bau/${POST.toUpperCase()}`),
    ).toEqual({ serverId: SERVER, postId: POST });
  });

  it("refuses anything that is not a post address", () => {
    expect(parseBauPostPath(`/app/server/${SERVER}/bau`)).toBeNull();
    expect(parseBauPostPath(`/app/server/${SERVER}`)).toBeNull();
    expect(parseBauPostPath(`/app/server/${SERVER}/channel/${POST}`)).toBeNull();
    expect(parseBauPostPath(`/app/server/not-a-uuid/bau/${POST}`)).toBeNull();
    expect(parseBauPostPath(`/other/app/server/${SERVER}/bau/${POST}`)).toBeNull();
    expect(parseBauPostPath(`${PATH}/extra`)).toBeNull();
  });
});

describe("findBauPostLinks", () => {
  it("finds a link in prose, ignoring a trailing sentence mark and a query", () => {
    const text = `Olha o novo post https://pqp.gg${PATH}?ref=x. Corre!`;
    const [link] = findBauPostLinks(text);
    expect(link).toMatchObject({
      serverId: SERVER,
      postId: POST,
      origin: "https://pqp.gg",
      url: `https://pqp.gg${PATH}?ref=x`,
    });
    expect(text.slice(link!.start, link!.end)).toBe(link!.url);
  });

  it("finds several, in order, and skips unrelated links", () => {
    const other = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const text = `https://example.com/a http://localhost:5173${PATH} https://pqp.gg${bauPostPath(SERVER, other)}`;
    const links = findBauPostLinks(text);
    expect(links.map((l) => l.postId)).toEqual([POST, other]);
    expect(links[0]!.origin).toBe("http://localhost:5173");
  });

  it("returns nothing for text with no post link", () => {
    expect(findBauPostLinks("")).toEqual([]);
    expect(findBauPostLinks(`https://pqp.gg/app/server/${SERVER}/channel/${POST}`)).toEqual([]);
    expect(findBauPostLinks(`pqp.gg${PATH}`)).toEqual([]);
  });
});

describe("bodyIsOnlyBauLink", () => {
  it("is true for the bare link and false when words surround it", () => {
    const bare = `https://pqp.gg${PATH}`;
    expect(bodyIsOnlyBauLink(bare, findBauPostLinks(bare)[0]!)).toBe(true);
    expect(bodyIsOnlyBauLink(` ${bare}\n`, findBauPostLinks(` ${bare}\n`)[0]!)).toBe(true);
    const noted = `Novo! ${bare}`;
    expect(bodyIsOnlyBauLink(noted, findBauPostLinks(noted)[0]!)).toBe(false);
  });
});
