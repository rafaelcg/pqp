import { describe, expect, it } from "vitest";
import { bidiClean, isolate, isolateOpt } from "./bidi";

const FSI = "⁨";
const PDI = "⁩";

describe("bidi helpers", () => {
  it("isolate wraps text in first-strong isolate characters", () => {
    expect(isolate("Gabi")).toBe(`${FSI}Gabi${PDI}`);
    expect(isolate("مرحبا")).toBe(`${FSI}مرحبا${PDI}`);
  });

  it("drops every override, embedding and isolate control first, so the isolate cannot be closed early", () => {
    expect(bidiClean("a‮b‪c‬d⁧e⁩f⁦g⁨h‫i‭j")).toBe("abcdefghij");
    expect(isolate(`evil${PDI} started by you ${FSI}`)).toBe(`${FSI}evil started by you ${PDI}`);
  });

  it("keeps the implicit marks and the joiners, which real text needs", () => {
    const text = "a‎b‏c؜d‍e‌f";
    expect(bidiClean(text)).toBe(text);
  });

  it("an empty value stays empty, and an absent one is empty", () => {
    expect(isolate("")).toBe("");
    expect(isolate("‮")).toBe("");
    expect(isolateOpt(null)).toBe("");
    expect(isolateOpt(undefined)).toBe("");
    expect(isolateOpt("x")).toBe(`${FSI}x${PDI}`);
  });
});
