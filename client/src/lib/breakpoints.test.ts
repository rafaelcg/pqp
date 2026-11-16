import { describe, expect, it } from "vitest";
import {
  BELOW_MD_QUERY,
  BELOW_SM_QUERY,
  LG_UP_QUERY,
  MD_UP_QUERY,
  SM_UP_QUERY,
} from "@/lib/breakpoints";

const rem = (query: string) => Number(/([\d.]+)rem/.exec(query)?.[1]);

describe("the app's breakpoints", () => {
  it("are Tailwind's sm, md and lg, in rem", () => {
    expect(rem(SM_UP_QUERY)).toBe(40);
    expect(rem(MD_UP_QUERY)).toBe(48);
    expect(rem(LG_UP_QUERY)).toBe(64);
  });

  it("stop each 'below' query just short of its 'from' query, so the two never overlap", () => {
    expect(rem(BELOW_SM_QUERY)).toBeLessThan(rem(SM_UP_QUERY));
    expect(rem(SM_UP_QUERY) - rem(BELOW_SM_QUERY)).toBeLessThan(0.01);
    expect(rem(BELOW_MD_QUERY)).toBeLessThan(rem(MD_UP_QUERY));
    expect(rem(MD_UP_QUERY) - rem(BELOW_MD_QUERY)).toBeLessThan(0.01);
  });
});
