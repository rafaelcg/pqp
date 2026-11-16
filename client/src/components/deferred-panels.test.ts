import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The split only works while nothing on the first screen imports a deferred
 * module statically. One stray `import { X } from "..."` anywhere in the shell's
 * import graph folds the chunk back into the entry and the build says nothing:
 * it is the same bytes in a differently named file. This walks the static
 * import graph from the two shell roots (`main.tsx`, which loads the chat client
 * with a dynamic import, and `App.tsx`, the chat client itself) and fails when it
 * reaches a module that `deferred-panels.tsx` or the stories and Discord import
 * hosts load with `import()`.
 *
 * Type-only imports do not count (they are erased), dynamic `import()` is the
 * point, and test files are not part of the bundle. It reads source text with
 * regexes rather than building anything, so it runs in the ordinary unit suite.
 */

const SRC = path.resolve(__dirname, "..");

const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModule(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(SRC, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(from), spec);
  } else {
    return null; // a package
  }
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Specifiers of every static import or re-export in `source` that survives type
 * erasure. Exported shapes handled: `import x from`, `import { a, type B } from`,
 * `import * as n from`, `import "side-effect"`, `export { a } from`,
 * `export * from`, all of them possibly spread over several lines.
 */
export function parseStaticImports(source: string): string[] {
  const text = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const found: string[] = [];
  for (const match of text.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) {
    found.push(match[1]!);
  }
  const fromClause =
    /^[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*["']([^"']+)["']/gm;
  for (const match of text.matchAll(fromClause)) {
    if (match[2]) {
      continue; // `import type ...` / `export type ...`
    }
    const clause = match[3]!.trim();
    // `import { type A, type B } from` is erased whole; one value specifier keeps it.
    if (clause.startsWith("{")) {
      const specifiers = clause
        .slice(1, -1)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (specifiers.length > 0 && specifiers.every((part) => part.startsWith("type "))) {
        continue;
      }
    }
    found.push(match[4]!);
  }
  return found;
}

function staticImports(file: string): string[] {
  return parseStaticImports(fs.readFileSync(file, "utf8"));
}

function dynamicImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
}

const HOSTS = [
  "components/deferred-panels.tsx",
  "components/stories/stories-host.tsx",
  "components/layout/discord-import-host.tsx",
].map((f) => path.join(SRC, f));

const deferred = new Map<string, string>();
for (const host of HOSTS) {
  for (const spec of dynamicImports(host)) {
    const resolved = resolveModule(spec, host);
    if (resolved) {
      deferred.set(resolved, spec);
    }
  }
}

function reachableFrom(roots: string[]): Map<string, string> {
  const seen = new Map<string, string>(); // file -> the file that imported it
  const queue = [...roots];
  for (const root of roots) {
    seen.set(root, "(root)");
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx)$/.test(file) || /\.test\.(ts|tsx)$/.test(file)) {
      continue;
    }
    for (const spec of staticImports(file)) {
      const next = resolveModule(spec, file);
      if (next && !seen.has(next)) {
        seen.set(next, file);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("parseStaticImports", () => {
  it("sees every static form, over several lines, and skips what is erased", () => {
    const source = [
      'import "./side-effect.css";',
      'import Default from "./default";',
      "import {",
      "  a,",
      "  type B,",
      '} from "./braced";',
      'import { type OnlyType } from "./all-types";',
      'import type { Declared } from "./declared";',
      'import * as ns from "./star";',
      'import Def, { named } from "./mixed";',
      'export { re } from "./reexport";',
      'export type { T } from "./reexport-type";',
      'export * from "./reexport-all";',
      '// import { Commented } from "./commented";',
      'const lazy = () => import("./dynamic");',
    ].join("\n");
    expect(parseStaticImports(source).sort()).toEqual(
      [
        "./side-effect.css",
        "./default",
        "./braced",
        "./star",
        "./mixed",
        "./reexport",
        "./reexport-all",
      ].sort(),
    );
  });
});

describe("deferred panels", () => {
  it("the walk reaches the shell's own modules (so a leak could be seen)", () => {
    const reachable = reachableFrom([
      path.join(SRC, "main.tsx"),
      path.join(SRC, "App.tsx"),
    ]);
    const names = new Set([...reachable.keys()].map((f) => path.relative(SRC, f)));
    expect(names.has("components/layout/channel-list.tsx")).toBe(true);
    expect(names.has("hooks/use-voice.ts")).toBe(true);
    expect(reachable.size).toBeGreaterThan(300);
  });

  it("lists the surfaces this guards", () => {
    // If the host files ever stop using import(), the guard below would pass
    // for the wrong reason.
    expect(deferred.size).toBeGreaterThanOrEqual(30);
  });

  it("are not reachable by a static import from the shell", () => {
    const reachable = reachableFrom([
      path.join(SRC, "main.tsx"),
      path.join(SRC, "App.tsx"),
    ]);
    const leaks: string[] = [];
    for (const [file, spec] of deferred) {
      const via = reachable.get(file);
      if (via) {
        const chain: string[] = [];
        for (let cur: string | undefined = file; cur && cur !== "(root)"; cur = reachable.get(cur)) {
          chain.push(path.relative(SRC, cur));
          if (chain.length > 12) {
            break;
          }
        }
        leaks.push(`${spec}: ${chain.join(" <- ")}`);
      }
    }
    expect(leaks, "a deferred module is imported statically from the shell").toEqual([]);
  });
});
