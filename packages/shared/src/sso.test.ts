import { describe, expect, it } from "vitest";
import {
  domainsMatch,
  emailDomainOf,
  normalizeEmailDomain,
  ssoEmailDomainSchema,
} from "./sso.js";

describe("normalizeEmailDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeEmailDomain("  ACME.Com  ")).toBe("acme.com");
  });

  it("strips a single trailing dot (the FQDN root)", () => {
    expect(normalizeEmailDomain("acme.com.")).toBe("acme.com");
  });

  it("accepts hyphens and digits inside labels", () => {
    expect(normalizeEmailDomain("my-corp3.co.uk")).toBe("my-corp3.co.uk");
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a bare TLD", "com"],
    ["a leading dot", ".acme.com"],
    ["a double dot", "acme..com"],
    ["a leading hyphen", "-acme.com"],
    ["a trailing hyphen", "acme-.com"],
    ["a space inside", "ac me.com"],
    ["an @ sign", "@acme.com"],
    ["a path", "acme.com/evil"],
    ["a scheme", "https://acme.com"],
    ["a port", "acme.com:25"],
    ["underscores", "ac_me.com"],
  ])("rejects %s", (_label, input) => {
    expect(normalizeEmailDomain(input)).toBeNull();
  });

  it("rejects an over-long label and an over-long domain", () => {
    expect(normalizeEmailDomain(`${"a".repeat(64)}.com`)).toBeNull();
    expect(normalizeEmailDomain(`${"a".repeat(250)}.com`)).toBeNull();
  });
});

describe("emailDomainOf", () => {
  it("extracts and normalizes the domain", () => {
    expect(emailDomainOf("Person@ACME.com")).toBe("acme.com");
  });

  it.each([
    ["no @", "person.acme.com"],
    ["two @", "person@acme@com"],
    ["no local part", "@acme.com"],
    ["no domain", "person@"],
  ])("rejects an address with %s", (_label, input) => {
    expect(emailDomainOf(input)).toBeNull();
  });
});

describe("domainsMatch", () => {
  it("matches an exact domain", () => {
    expect(domainsMatch(["acme.com"], "acme.com")).toBe(true);
  });

  it("matches on a non-primary verified domain", () => {
    // The reason domains are a list: a personal primary address must not lock
    // someone out of their own employer's server.
    expect(domainsMatch(["gmail.com", "acme.com"], "acme.com")).toBe(true);
  });

  it("never matches when either side is missing", () => {
    expect(domainsMatch(null, "acme.com")).toBe(false);
    expect(domainsMatch([], "acme.com")).toBe(false);
    expect(domainsMatch(["acme.com"], null)).toBe(false);
    expect(domainsMatch(undefined, undefined)).toBe(false);
    // An unverified user (no domains) must not match a server that also has
    // no domain set — "both empty" is not a match, it is the feature being off.
    expect(domainsMatch([], null)).toBe(false);
  });

  it("does not match a subdomain in either direction", () => {
    expect(domainsMatch(["mail.acme.com"], "acme.com")).toBe(false);
    expect(domainsMatch(["acme.com"], "mail.acme.com")).toBe(false);
  });

  it("does not match a lookalike suffix or prefix", () => {
    // The attacks a naive endsWith/startsWith would let through.
    expect(domainsMatch(["acme.com.evil.test"], "acme.com")).toBe(false);
    expect(domainsMatch(["evil-acme.com"], "acme.com")).toBe(false);
    expect(domainsMatch(["notacme.com"], "acme.com")).toBe(false);
  });
});

describe("ssoEmailDomainSchema", () => {
  it("normalizes valid input", () => {
    expect(ssoEmailDomainSchema.parse("  ACME.com. ")).toBe("acme.com");
  });

  it("rejects a malformed domain", () => {
    expect(ssoEmailDomainSchema.safeParse("not a domain").success).toBe(false);
  });

  it("rejects public mail providers, case-insensitively", () => {
    for (const domain of ["gmail.com", "GMAIL.com", "outlook.com", "proton.me"]) {
      const result = ssoEmailDomainSchema.safeParse(domain);
      expect(result.success, `${domain} should be rejected`).toBe(false);
    }
  });

  it("allows a domain that merely contains a provider name", () => {
    expect(ssoEmailDomainSchema.parse("gmail.acme.com")).toBe("gmail.acme.com");
  });
});
