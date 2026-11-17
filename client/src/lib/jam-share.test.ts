import { describe, expect, it } from "vitest";
import {
  findJamSongLinks,
  jamSongShareUrl,
  parseJamSongPath,
  selectJamCardLink,
  stripJamLink,
} from "@/lib/jam-share";

const SERVER = "0f5b7a3e-1c2d-4e8f-9a0b-1234567890ab";
const JAM = "11111111-2222-4333-8444-555555555555";
const SONG = "aa11bb22-cc33-4dd4-8ee5-ff6677889900";
const PATH = `/app/server/${SERVER}/channel/${JAM}/song/${SONG}`;

describe("parseJamSongPath", () => {
  it("reads the address the Jam's own address bar shows", () => {
    expect(parseJamSongPath(PATH)).toEqual({ serverId: SERVER, channelId: JAM, songId: SONG });
    expect(parseJamSongPath(`${PATH}/`)).toEqual({ serverId: SERVER, channelId: JAM, songId: SONG });
  });

  it("lowercases ids so a shouted link still names the row", () => {
    expect(parseJamSongPath(PATH.toUpperCase().replace("/APP/SERVER/", "/app/server/").replace("/CHANNEL/", "/channel/").replace("/SONG/", "/song/"))).toEqual({
      serverId: SERVER,
      channelId: JAM,
      songId: SONG,
    });
  });

  it("refuses anything that is not a song address", () => {
    expect(parseJamSongPath(`/app/server/${SERVER}/channel/${JAM}`)).toBeNull();
    expect(parseJamSongPath(`/app/server/${SERVER}/channel/${JAM}/post/${SONG}`)).toBeNull();
    expect(parseJamSongPath(`/app/server/${SERVER}/bau/${SONG}`)).toBeNull();
    expect(parseJamSongPath(`${PATH}/extra`)).toBeNull();
    expect(parseJamSongPath(`/app/server/nope/channel/${JAM}/song/${SONG}`)).toBeNull();
  });
});

describe("jamSongShareUrl", () => {
  it("is the origin plus the song's own route, and reads back as the same song", () => {
    const url = jamSongShareUrl("https://pqp.gg", { serverId: SERVER, channelId: JAM, songId: SONG });
    expect(url).toBe(`https://pqp.gg${PATH}`);
    expect(findJamSongLinks(url)[0]).toMatchObject({ serverId: SERVER, channelId: JAM, songId: SONG });
  });
});

describe("findJamSongLinks", () => {
  it("finds a link in prose, ignoring a trailing sentence mark and a query", () => {
    const text = `Olha essa https://pqp.gg${PATH}?x=1. Bora!`;
    const [link] = findJamSongLinks(text);
    expect(link).toMatchObject({ songId: SONG, origin: "https://pqp.gg", url: `https://pqp.gg${PATH}?x=1` });
    expect(text.slice(link!.start, link!.end)).toBe(link!.url);
  });

  it("skips other links and plain text", () => {
    expect(findJamSongLinks("https://example.com/a pqp.gg" + PATH)).toEqual([]);
    expect(findJamSongLinks("")).toEqual([]);
  });
});

describe("selectJamCardLink", () => {
  it("takes a link on this instance, and says whether the message is only the link", () => {
    expect(selectJamCardLink(`http://localhost:5173${PATH}`, "http://localhost:5173")?.linkOnly).toBe(true);
    expect(selectJamCardLink(`ouve: http://localhost:5173${PATH}`, "http://localhost:5173")?.linkOnly).toBe(false);
  });

  it("the hosted app counts as this instance; somebody else's pqp does not", () => {
    expect(selectJamCardLink(`https://pqp.gg${PATH}`, "http://localhost:5173")).not.toBeNull();
    expect(selectJamCardLink(`https://evil.example${PATH}`, "http://localhost:5173")).toBeNull();
  });

  it("nothing for an empty body", () => {
    expect(selectJamCardLink(null, null)).toBeNull();
    expect(selectJamCardLink("", null)).toBeNull();
  });
});

describe("stripJamLink", () => {
  it("leaves the sender's words and drops the pasted address", () => {
    const body = `ouve isso\nhttps://pqp.gg${PATH}\nficou bom`;
    const link = findJamSongLinks(body)[0]!;
    expect(stripJamLink(body, link)).toBe("ouve isso\n\nficou bom");
    expect(stripJamLink(`https://pqp.gg${PATH}`, findJamSongLinks(`https://pqp.gg${PATH}`)[0]!)).toBe("");
  });
});
