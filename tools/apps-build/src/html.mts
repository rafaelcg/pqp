import { posix } from "node:path";
import { sriSha384 } from "./hash.mts";

interface Attr {
  name: string;
  /** `null` for a bare attribute such as `crossorigin` or `defer`. */
  value: string | null;
}

const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source: string): Attr[] {
  const attrs: Attr[] = [];
  for (const match of source.matchAll(ATTR)) {
    attrs.push({ name: match[1]!, value: match[2] ?? match[3] ?? match[4] ?? null });
  }
  return attrs;
}

function attr(attrs: Attr[], name: string): Attr | undefined {
  return attrs.find((a) => a.name.toLowerCase() === name);
}

function render(tag: string, attrs: Attr[], selfClosing: boolean): string {
  const parts = attrs.map((a) => (a.value === null ? a.name : `${a.name}="${a.value}"`));
  return `<${tag}${parts.length ? ` ${parts.join(" ")}` : ""}${selfClosing ? " /" : ""}>`;
}

/** A reference an entry page may make: relative, inside the bundle, no scheme, no query tricks. */
export function bundleRef(htmlPath: string, ref: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/")) {
    throw new Error(`${htmlPath}: "${ref}" is not a relative bundle path`);
  }
  const clean = ref.split(/[?#]/)[0]!;
  const resolved = posix.normalize(posix.join(posix.dirname(htmlPath), clean));
  if (resolved.startsWith("../") || resolved === "..") {
    throw new Error(`${htmlPath}: "${ref}" leaves the bundle`);
  }
  return resolved;
}

/**
 * Prepares the built entry page for the sandbox and writes Subresource
 * Integrity on every script and stylesheet:
 *
 * - every `<script src>` and `<link rel=stylesheet|modulepreload>` gets
 *   `integrity="sha384-..."` of the file it names, and `crossorigin` (SRI on an
 *   opaque-origin document needs a CORS request);
 * - the build FAILS on what the frame's CSP would silently refuse: an inline
 *   `<script>` or `<style>`, a `style=` attribute, an `on*=` handler, a
 *   `<base>`, a `<meta http-equiv>`, an `<iframe>`/`<object>`/`<embed>`, or any
 *   `src`/`href` that is not a relative path inside the bundle.
 *
 * `read(path)` returns the bytes of a bundle file by its path.
 */
export function addIntegrity(
  html: string,
  htmlPath: string,
  read: (bundlePath: string) => Uint8Array,
): string {
  // an inline script or style body is invisible to the attribute checks below
  for (const match of html.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const tag = match[1]!.toLowerCase();
    const attrs = parseAttrs(match[2]!);
    if (tag === "style") {
      throw new Error(`${htmlPath}: an inline <style> is refused by the frame's CSP, use a stylesheet file`);
    }
    if (!attr(attrs, "src") || match[3]!.trim() !== "") {
      throw new Error(`${htmlPath}: an inline <script> is refused by the frame's CSP, use a script file`);
    }
  }
  const result = html.replace(TAG, (full, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs = parseAttrs(selfClosing ? rawAttrs.replace(/\/\s*$/, "") : rawAttrs);
    for (const a of attrs) {
      const name = a.name.toLowerCase();
      if (name === "style") throw new Error(`${htmlPath}: a style= attribute is refused by the frame's CSP`);
      if (name.startsWith("on")) throw new Error(`${htmlPath}: the ${a.name}= handler is refused by the frame's CSP`);
    }
    if (tag === "base" || tag === "iframe" || tag === "object" || tag === "embed") {
      throw new Error(`${htmlPath}: <${tag}> is not allowed in an app entry page`);
    }
    if (tag === "meta" && attr(attrs, "http-equiv")) {
      throw new Error(`${htmlPath}: <meta http-equiv> is not allowed in an app entry page`);
    }
    if (tag === "script" || tag === "link") {
      const refAttr = tag === "script" ? attr(attrs, "src") : attr(attrs, "href");
      const rel = (attr(attrs, "rel")?.value ?? "").toLowerCase().split(/\s+/);
      const needsSri =
        tag === "script" ? refAttr !== undefined : rel.includes("stylesheet") || rel.includes("modulepreload");
      if (tag === "link" && !needsSri) {
        if (refAttr?.value) bundleRef(htmlPath, refAttr.value);
        return full;
      }
      if (!needsSri) return full;
      if (!refAttr?.value) throw new Error(`${htmlPath}: <${tag}> without a ${tag === "script" ? "src" : "href"}`);
      const file = bundleRef(htmlPath, refAttr.value);
      const integrity = sriSha384(read(file));
      const without = attrs.filter((a) => a.name.toLowerCase() !== "integrity");
      if (!attr(without, "crossorigin")) without.push({ name: "crossorigin", value: "anonymous" });
      without.push({ name: "integrity", value: integrity });
      return render(rawTag, without, selfClosing);
    }
    // images and media are checked for where they point, not rewritten
    if (["img", "source", "audio", "video", "track", "input"].includes(tag)) {
      const target = attr(attrs, "src");
      if (target?.value && !target.value.startsWith("data:") && !target.value.startsWith("blob:")) {
        bundleRef(htmlPath, target.value);
      }
    }
    return full;
  });
  return result;
}
