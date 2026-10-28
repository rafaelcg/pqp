#!/usr/bin/env node
/**
 * One table per run of the share smoke test, for a person reading the job:
 * what was shared, what Chromium answered, how long it took, and what this
 * runner could NOT check. Written to the job summary on CI, stdout elsewhere.
 *
 *   node electron/test/share-smoke/summary.mjs <results dir>
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "test-results/share-smoke");
const scenariosDir = path.join(dir, "scenarios");
const run = existsSync(path.join(dir, "run.json"))
  ? JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"))
  : {};
const scenarios = existsSync(scenariosDir)
  ? readdirSync(scenariosDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(path.join(scenariosDir, f), "utf8")))
  : [];

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function outcome(s) {
  const r = s.result;
  if (!r) {
    return s.problems?.join("; ") || "no result";
  }
  if (r.error) {
    return `${r.error.name}${r.error.constraint ? ` (${r.error.constraint})` : ""}: ${r.error.message}`;
  }
  const v = r.video;
  const audio = r.audio?.length
    ? r.audio.map((a) => `${a.readyState} ${a.label || "audio"}`).join(", ")
    : "none";
  return v
    ? `${v.width}x${v.height} ${v.settings?.displaySurface ?? "?"}, frames ${v.framesBefore} then ${v.framesAfter}, audio: ${audio}`
    : "no video track";
}

const lines = [
  `### Share smoke: ${cell(run.platform ?? "?")} ${cell(run.osRelease ?? "")}`,
  "",
  `App: \`${cell(run.app?.command ?? "?")}\` (${cell(run.app?.kind ?? "?")}), ${cell(run.app?.browser ?? "")}`,
  "",
  "| Scenario | Verdict | Asked for | Picker | Result | Not verified here | ms |",
  "|---|---|---|---|---|---|---|",
];
for (const s of scenarios) {
  const known = s.name.startsWith("known-bad");
  const verdict = known
    ? s.ok
      ? "red, as it must be"
      : "NOT red: the gate is blind"
    : s.ok
      ? "pass"
      : "FAIL";
  const asked = s.result
    ? `audio ${s.result.askedForAudio ? "yes" : "no"}${s.result.nativeAudio ? " (native)" : ""}`
    : "";
  const picker = s.picker
    ? s.picker.error
      ? `error: ${s.picker.error}`
      : `${s.picker.sources} sources (${s.picker.screens} screens), sound row ${
          s.picker.audioRow?.hasSwitch ? (s.picker.checkedAtShare ? "on" : "off") : "absent"
        }`
    : "not shown";
  lines.push(
    `| ${cell(s.name)} | ${verdict} | ${cell(asked)} | ${cell(picker)} | ${cell(outcome(s))}${
      s.problems?.length && !known ? ` <br>${cell(s.problems.join("; "))}` : ""
    } | ${cell((s.notVerified ?? []).join("; "))} | ${cell(s.elapsed)} |`,
  );
}
if (scenarios.length === 0) {
  lines.push("| (no scenario reported: the app never reached the test page) | FAIL | | | | | |");
}
const text = `${lines.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
process.stdout.write(text);
