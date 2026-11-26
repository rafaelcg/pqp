import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JAM_SHARE_NETWORKS,
  JAM_SHARE_REF,
  jamPublicSongLink,
  jamShareNetworkHref,
  jamShareable,
} from "./jam-share-link";
import { publicJamViewUrl } from "./jam-public-links";

const ID = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";
const hosted = { protocol: "https:", hostname: "pqp.gg", host: "pqp.gg" };
const hostedJam = { protocol: "https:", hostname: "jam.pqp.gg", host: "jam.pqp.gg" };
const local = { protocol: "http:", hostname: "localhost", host: "localhost:5173" };
const localJam = { protocol: "http:", hostname: "jam.localhost", host: "jam.localhost:5173" };

describe("jamPublicSongLink", () => {
  it("is the public song page on the Jam site, tagged ref=share", () => {
    expect(jamPublicSongLink(ID, { where: hosted })).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
    expect(jamPublicSongLink(ID, { where: hostedJam })).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
    expect(jamPublicSongLink(ID, { where: { ...hosted, hostname: "www.pqp.gg", host: "www.pqp.gg" } })).toBe(
      `https://jam.pqp.gg/m/${ID}?ref=share`,
    );
  });

  it("follows a self-host or a preview onto its own /jam mount, and a jam. host onto its root mount", () => {
    expect(jamPublicSongLink(ID, { where: local })).toBe(`http://localhost:5173/jam/m/${ID}?ref=share`);
    expect(jamPublicSongLink(ID, { where: localJam })).toBe(`http://jam.localhost:5173/m/${ID}?ref=share`);
  });

  it("is never an /app address", () => {
    for (const where of [hosted, hostedJam, local, localJam]) {
      expect(jamPublicSongLink(ID, { where })).not.toContain("/app");
    }
  });

  it("keeps the ref the site page was opened with, and says share otherwise", () => {
    expect(jamPublicSongLink(ID, { where: hostedJam, attribution: { ref: "clip-ana" } })).toBe(
      `https://jam.pqp.gg/m/${ID}?ref=clip-ana`,
    );
    expect(jamPublicSongLink(ID, { where: hostedJam, attribution: { utm_source: "tiktok", utm_medium: "social" } })).toBe(
      `https://jam.pqp.gg/m/${ID}?ref=${JAM_SHARE_REF}`,
    );
    expect(jamPublicSongLink(ID, { where: hostedJam, attribution: null })).toBe(`https://jam.pqp.gg/m/${ID}?ref=share`);
  });

  it("adds nothing else: no utm, no from=app", () => {
    const url = new URL(jamPublicSongLink(ID, { where: hosted, attribution: { ref: "x", utm_source: "tiktok" } }));
    expect([...url.searchParams.keys()]).toEqual(["ref"]);
  });

  it("leaves the tag off a link the person follows themselves", () => {
    expect(publicJamViewUrl(ID, hosted)).toBe(`https://jam.pqp.gg/m/${ID}`);
    expect(publicJamViewUrl(ID, local)).toBe(`http://localhost:5173/jam/m/${ID}`);
  });
});

describe("jamShareable", () => {
  it("only a live song has a page a stranger can open", () => {
    expect(jamShareable("live")).toBe(true);
    for (const status of ["review", "hidden", "removed", "unpublished", null, undefined]) {
      expect(jamShareable(status)).toBe(false);
    }
  });
});

describe("jamShareNetworkHref", () => {
  const text = "Maré baixa: falta baixo nessa. Grava a tua parte:";
  const url = `https://jam.pqp.gg/m/${ID}?ref=share`;

  it("opens each network's own composer with the message and the link in it", () => {
    expect(jamShareNetworkHref("whatsapp", text, url)).toBe(`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`);
    expect(jamShareNetworkHref("telegram", text, url)).toBe(
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    );
    expect(jamShareNetworkHref("x", text, url)).toBe(
      `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    );
  });

  it("offers exactly WhatsApp, X and Telegram", () => {
    expect([...JAM_SHARE_NETWORKS]).toEqual(["whatsapp", "x", "telegram"]);
  });

  it("keeps the link whole through the encoding (its ? and = must not end the message)", () => {
    const wa = new URL(jamShareNetworkHref("whatsapp", text, url));
    expect(wa.searchParams.get("text")).toBe(`${text} ${url}`);
  });
});

// ---------------------------------------------------------------- every place that builds a jam link

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "locales" || name === "node_modules") continue;
      sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const files = sources(SRC).map((file) => ({ rel: relative(SRC, file), text: readFileSync(file, "utf8") }));

/**
 * The files that may spell a jam address by hand, and why. Anything else that needs the address of a
 * public song goes through `jamPublicSongLink`.
 */
const MAY_SPELL_AN_ADDRESS: Record<string, string> = {
  "lib/jam-share-link.ts": "the one builder",
  "jam-site/route.ts": "the site's own routing: where a click inside the site goes (jamPath), not what is handed out",
  "lib/jam-intent.ts": "the return path from the app to the site (?from=app), a navigation and not a share",
  "lib/jam-meta.ts": "the canonical <link> and og:url of a page, which name the song once and carry no ref",
};

/** What a hand-written public jam address looks like in source. */
const ADDRESS = /jam\.pqp\.gg\/m\/|["'`]\/jam\/m\/|\/jam\/m\/\$\{|["'`]\/m\/\$\{/;

describe("every share and copy of a jam link goes through the one builder", () => {
  it("no file outside the allowed list spells a public jam address", () => {
    const offenders = files
      .filter((file) => ADDRESS.test(file.text) && !(file.rel in MAY_SPELL_AN_ADDRESS))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it("the allowed list has no stale entries", () => {
    const present = new Set(files.map((file) => file.rel));
    expect(Object.keys(MAY_SPELL_AN_ADDRESS).filter((rel) => !present.has(rel))).toEqual([]);
  });

  it("every surface that shares or copies a song imports the builder", () => {
    // The places a person can send a song to somebody outside, each with the reason it is listed.
    const SURFACES: Record<string, string> = {
      "components/jam/jam-invite.tsx": "the studio's 'chama a galera' moment, the song panel's share, its dialog",
      "jam-site/share-menu.tsx": "the public song page's Compartilhar (native sheet, copy, WhatsApp, X, Telegram)",
      "lib/jam-public-links.ts": "publicJamViewUrl, the 'see it live' link of the starter's sheet (untagged on purpose)",
    };
    for (const rel of Object.keys(SURFACES)) {
      const file = files.find((one) => one.rel === rel);
      expect(file, rel).toBeDefined();
      expect(file!.text, rel).toMatch(/jamPublicSongLink/);
    }
  });

  it("nothing else in the jam code calls the share sheet or the clipboard on its own", () => {
    const direct = /navigator\.share\b|navigator\.clipboard\.writeText|execCommand\(["']copy["']\)/;
    const allowed = new Set(["lib/jam-share-run.ts", "lib/jam-clipboard.ts"]);
    const offenders = files
      .filter((file) => /jam/i.test(file.rel) && direct.test(file.text) && !allowed.has(file.rel))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it("no jam surface offers a chat-only /app address as the thing to share outside", () => {
    // The chat card (jam-share.ts) is for people already in the server; it must never be what the share moment hands out.
    for (const rel of ["components/jam/jam-invite.tsx", "jam-site/share-menu.tsx"]) {
      const file = files.find((one) => one.rel === rel)!;
      expect(file.text).not.toMatch(/jamSongShareUrl|jamSongRoutePath|\/app\//);
    }
  });
});
