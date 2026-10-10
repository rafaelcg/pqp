import { describe, expect, it } from "vitest";
import {
  channelRef,
  channelRefsToPlain,
  hasChannelRefs,
  protectChannelRefs,
  splitChannelRefs,
} from "./community-home-channel-refs.js";

const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("channel references", () => {
  it("splits a body into text and channel parts, in order", () => {
    expect(splitChannelRefs(`manda um áudio no <#${A}> hoje e no <#${B}>!`)).toEqual([
      { type: "text", value: "manda um áudio no " },
      { type: "channel", id: A },
      { type: "text", value: " hoje e no " },
      { type: "channel", id: B },
      { type: "text", value: "!" },
    ]);
  });

  it("is case-insensitive on the id and normalises it to lowercase", () => {
    expect(splitChannelRefs(`<#${A.toUpperCase()}>`)).toEqual([
      { type: "channel", id: A },
    ]);
    expect(channelRef(A.toUpperCase())).toBe(`<#${A}>`);
  });

  it("leaves things that are not a uuid reference alone", () => {
    for (const text of ["#geral", "<#geral>", "<#1234>", "<#>", `<${A}>`]) {
      expect(splitChannelRefs(text)).toEqual([{ type: "text", value: text }]);
      expect(hasChannelRefs(text)).toBe(false);
    }
    expect(hasChannelRefs(`x <#${A}>`)).toBe(true);
    expect(hasChannelRefs(null)).toBe(false);
  });

  it("turns references into #name for places that cannot link", () => {
    expect(
      channelRefsToPlain(`veja <#${A}> e <#${B}>`, (id) =>
        id === A ? "geral" : null,
      ),
    ).toBe("veja #geral e #channel");
  });
});

describe("protectChannelRefs", () => {
  it("swaps ids for short placeholders and puts them back", () => {
    const guard = protectChannelRefs([
      `Testa no <#${A}> e no <#${B}>, depois volta no <#${A}>`,
      "sem canal",
    ]);
    expect(guard.texts).toEqual([
      "Testa no <#1> e no <#2>, depois volta no <#1>",
      "sem canal",
    ]);
    expect(
      guard.restore([
        "Try it in <#1> and in <#2>, then back in <#1>",
        "no channel",
      ]),
    ).toEqual([
      `Try it in <#${A}> and in <#${B}>, then back in <#${A}>`,
      "no channel",
    ]);
  });

  it("lets the translator move a placeholder", () => {
    const guard = protectChannelRefs([`<#${A}> é o canal`]);
    expect(guard.restore(["The channel is <#1>"])).toEqual([
      `The channel is <#${A}>`,
    ]);
  });

  it("gives null for a field that lost, duplicated or invented a placeholder", () => {
    const guard = protectChannelRefs([`a <#${A}> b <#${B}>`, `c <#${A}>`, "d"]);
    expect(guard.restore(["a <#1> b", "c <#1>", "d"])).toEqual([
      null,
      `c <#${A}>`,
      "d",
    ]);
    expect(guard.restore(["a <#1> <#1> b <#2>", "c <#1> <#1>", "d"])[0]).toBeNull();
    expect(guard.restore(["a <#1> b <#2>", "c", "d"])[1]).toBeNull();
    // A number we never sent is left as text and does not count as a link.
    expect(guard.restore(["a <#1> b <#2> <#9>", "c <#1>", "d"])[0]).toBe(
      `a <#${A}> b <#${B}> <#9>`,
    );
  });

  it("refuses to restore when the author's own text looks like a placeholder", () => {
    const guard = protectChannelRefs([`escreve <#1> literal e <#${A}>`]);
    expect(guard.restore(["write <#1> literal and <#1>"])).toEqual([null]);
  });

  it("is a no-op when there are no references", () => {
    const guard = protectChannelRefs(["hello", "world"]);
    expect(guard.texts).toEqual(["hello", "world"]);
    expect(guard.restore(["olá", "mundo"])).toEqual(["olá", "mundo"]);
  });
});
