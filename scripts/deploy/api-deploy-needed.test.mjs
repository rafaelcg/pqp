import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildExcludedMatchers,
  decide,
  globToRegExp,
} from "./api-deploy-needed.mjs";

/**
 * The deploy decision, exercised rather than reasoned about.
 *
 * The bug this closes was invisible because the logic was a `grep` inside a
 * YAML `run:` block: the only way to find out what it did was to merge
 * something and watch. So the rule that matters here is that BOTH answers are
 * pinned. "A test-only diff skips the deploy" on its own is the shape that
 * silently stops deploying real changes.
 */

/** The real `tsconfig.build.json` contents, as of this commit. */
const REAL = {
  "server/tsconfig.build.json": JSON.stringify({
    extends: "./tsconfig.json",
    exclude: ["src/**/*.test.ts"],
  }),
  "packages/shared/tsconfig.build.json": JSON.stringify({
    extends: "./tsconfig.json",
    exclude: ["src/**/*.test.ts", "src/**/*.fixture.ts"],
  }),
};

const matchers = () => buildExcludedMatchers((p) => REAL[p] ?? (() => { throw new Error("nope"); })());

test("a test-only server diff does not deploy", () => {
  const { needed } = decide(
    [
      "server/src/ws/voice-resume.test.ts",
      "server/src/ws/voice-cluster.test.ts",
      "server/src/api/age-gate.test.ts",
    ],
    matchers(),
  );
  assert.equal(needed, false);
});

test("one source file alongside the tests still deploys", () => {
  const { needed, reason } = decide(
    ["server/src/ws/voice-resume.test.ts", "server/src/ws/voice.ts"],
    matchers(),
  );
  assert.equal(needed, true);
  assert.match(reason, /voice\.ts/);
});

test("a test HELPER is not a test: it compiles, so it deploys", () => {
  // The exclude glob is `src/**/*.test.ts`. A file the build still compiles is
  // an ordinary source file however it is named, and this is the case the
  // instruction to key off the build rather than a naming convention exists
  // for.
  for (const file of [
    "server/src/ws/test-helpers.ts",
    "server/src/ws/fixtures/rooms.ts",
    "server/src/testing.ts",
  ]) {
    assert.equal(decide([file], matchers()).needed, true, file);
  }
});

test("server/test/ deploys: it is outside the build's exclude glob", () => {
  // `server/tsconfig.json` includes only `src`, so these never reach dist
  // either, but that is a second argument from a different file. The exclude
  // glob is the evidence this filter is allowed to use, and erring here costs
  // one needless restart rather than a skipped one.
  assert.equal(
    decide(["server/test/http.test.ts"], matchers()).needed,
    true,
  );
});

test("shared package tests and fixtures do not deploy", () => {
  assert.equal(
    decide(
      [
        "packages/shared/src/signaling.test.ts",
        "packages/shared/src/voice.fixture.ts",
      ],
      matchers(),
    ).needed,
    false,
  );
});

test("client-only changes do not deploy, which is the behaviour that already worked", () => {
  assert.equal(
    decide(["client/src/App.tsx", "docs/MONITORING.md"], matchers()).needed,
    false,
  );
});

test("infrastructure files deploy", () => {
  for (const file of [
    "Dockerfile",
    "fly.toml",
    "pnpm-lock.yaml",
    "packages/shared/src/signaling.ts",
    ".github/workflows/deploy-api-fly.yml",
  ]) {
    assert.equal(decide([file], matchers()).needed, true, file);
  }
});

test("an unreadable tsconfig excludes nothing, so everything deploys", () => {
  const none = buildExcludedMatchers(() => {
    throw new Error("missing");
  });
  assert.deepEqual(none, []);
  assert.equal(
    decide(["server/src/ws/voice.test.ts"], none).needed,
    true,
    "with no build config to consult, a test file has to deploy",
  );
});

test("a glob shape this does not understand excludes nothing", () => {
  assert.equal(globToRegExp("src/**/*.{test,spec}.ts"), null);
  const weird = buildExcludedMatchers(() =>
    JSON.stringify({ exclude: ["src/**/*.{test,spec}.ts"] }),
  );
  assert.deepEqual(weird, []);
});

test("the exclude globs really are what the repo ships", async () => {
  // The matchers above are built from a copy of the tsconfigs. If the real
  // ones drift, this catches it rather than letting the suite pass against a
  // fiction.
  const { readFileSync } = await import("node:fs");
  for (const [path, expected] of Object.entries(REAL)) {
    assert.deepEqual(
      JSON.parse(readFileSync(path, "utf8")).exclude,
      JSON.parse(expected).exclude,
      `${path} changed; update this test and re-check the filter`,
    );
  }
});
