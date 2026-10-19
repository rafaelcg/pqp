import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addIntegrity, bundleRef } from "./html.mts";

const files: Record<string, string> = { "index.js": "console.log(1)", "index.css": "body{}" };
const read = (path: string) => {
  const data = files[path];
  if (data === undefined) throw new Error(`no ${path}`);
  return new TextEncoder().encode(data);
};
const sri = (text: string) => `sha384-${createHash("sha384").update(text).digest("base64")}`;

const page = (head: string, body = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe("addIntegrity", () => {
  it("writes SRI and crossorigin on the script and the stylesheet", () => {
    const out = addIntegrity(
      page('<script type="module" crossorigin src="./index.js"></script><link rel="stylesheet" crossorigin href="./index.css">'),
      "index.html",
      read,
    );
    expect(out).toContain(`src="./index.js" integrity="${sri("console.log(1)")}"`);
    expect(out).toContain(`href="./index.css" integrity="${sri("body{}")}"`);
  });

  it("adds crossorigin when the tag has none, and replaces a stale integrity", () => {
    const out = addIntegrity(
      page('<script src="index.js" integrity="sha384-stale"></script>'),
      "index.html",
      read,
    );
    expect(out).toContain('crossorigin="anonymous"');
    expect(out).toContain(sri("console.log(1)"));
    expect(out).not.toContain("sha384-stale");
  });

  it("leaves a page without scripts alone and keeps data: images", () => {
    const html = page("", '<img src="data:image/png;base64,AAAA" alt="">');
    expect(addIntegrity(html, "index.html", read)).toBe(html);
  });

  it.each([
    ["an inline script", page("<script>alert(1)</script>"), /inline <script>/],
    ["an inline module script", page('<script type="module">import("./x")</script>'), /inline <script>/],
    ["an inline style", page("<style>body{}</style>"), /inline <style>/],
    ["a style attribute", page("", '<p style="color:red">x</p>'), /style= attribute/],
    ["an event handler", page("", '<button onclick="x()">x</button>'), /onclick=/],
    ["an external script", page('<script src="https://cdn.example.com/x.js"></script>'), /not a relative bundle path/],
    ["a protocol-relative stylesheet", page('<link rel="stylesheet" href="//cdn.example.com/x.css">'), /not a relative bundle path/],
    ["a root-absolute script", page('<script src="/index.js"></script>'), /not a relative bundle path/],
    ["a script that leaves the bundle", page('<script src="../x.js"></script>'), /leaves the bundle/],
    ["a base tag", page('<base href="https://evil.example/">'), /<base>/],
    ["a nested frame", page("", '<iframe src="./x.html"></iframe>'), /<iframe>/],
    ["a meta refresh", page('<meta http-equiv="refresh" content="0;url=https://evil.example">'), /http-equiv/],
    ["an external image", page("", '<img src="https://evil.example/p.png">'), /not a relative bundle path/],
  ])("fails on %s", (_name, html, message) => {
    expect(() => addIntegrity(html, "index.html", read)).toThrow(message);
  });

  it("resolves references against the page's own folder", () => {
    expect(bundleRef("index.html", "./a/b.js?x=1")).toBe("a/b.js");
    expect(bundleRef("sub/index.html", "../index.js")).toBe("index.js");
    expect(() => bundleRef("index.html", "data:text/javascript,1")).toThrow();
  });
});
