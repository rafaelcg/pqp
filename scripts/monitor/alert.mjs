/**
 * Turns check results into GitHub Issues.
 *
 * WHY GITHUB ISSUES
 * -----------------
 * The requirement is: free, reaches a phone, keeps history, and does not
 * depend on the thing being monitored. Issues are the only channel that hits
 * all four with zero setup:
 *   * free and unmetered on a public repo;
 *   * a new issue emails the repo owner AND pushes to the GitHub mobile app,
 *     so it reaches someone who is not looking at a dashboard;
 *   * the issue thread IS the incident history, searchable and permanent;
 *   * github.com is a separate failure domain from Fly, Cloudflare and the
 *     app itself, so it still works during exactly the outage it reports.
 *
 * The alternatives were rejected on facts, not taste. Email to
 * contato@pqp.gg currently bounces — Cloudflare Email Routing has the DNS but
 * no verified destination — so alerts would be written into a black hole. A
 * webhook into pqp itself is circular: the API being down is the single most
 * likely alert, and it is the thing that would have to deliver it.
 *
 * THE DEDUPE CONTRACT
 * -------------------
 * One open issue per check key, ever. It is found by a hidden marker in the
 * body rather than by title or by a per-key label, so a human can retitle it
 * mid-incident without the next run opening a duplicate.
 *
 *   fail/warn, nothing open  -> open one issue
 *   fail/warn, already open  -> comment at most once per `reminderHours`
 *   ok,        already open  -> comment "recovered" and close
 *   skip                     -> touch nothing
 *
 * The last two lines are the whole design. An alert that reopens every ten
 * minutes gets muted within a day, and a muted alert is worse than no alert
 * because it looks like coverage. `skip` leaving state alone matters just as
 * much: a check that could not run (missing credential, provider API down)
 * must never be read as "recovered".
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const ALERT_LABEL = "monitor";
const MARKER = (key) => `<!-- pqp-monitor:${key} -->`;

async function gh(args) {
  // Everything goes through argv, never a shell string: issue bodies contain
  // probe output, and one unescaped backtick in a status message must not
  // become a command.
  const { stdout } = await exec("gh", args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Idempotent; `--force` updates rather than failing when it already exists. */
async function ensureLabel(repo) {
  await gh([
    "label",
    "create",
    ALERT_LABEL,
    "--repo",
    repo,
    "--color",
    "b60205",
    "--description",
    "Opened automatically by the monitoring workflows",
    "--force",
  ]);
}

const FIELDS = "number,title,body,updatedAt";

/**
 * Every currently-open alert, keyed by check.
 *
 * TWO QUERIES, ON PURPOSE. Filtering `gh issue list` by label goes through
 * GitHub's label index, which is eventually consistent — measured here at
 * several seconds, during which a just-opened issue is invisible. Deduping on
 * that alone produced three duplicate issues for one incident in testing.
 * The UNFILTERED list is immediately consistent and is therefore the one that
 * prevents duplicates; the labelled list is unioned in only so that an alert
 * pushed past the 100 most recent open issues on a busy repo is still found.
 */
async function openAlerts(repo) {
  const [recent, labelled] = await Promise.all([
    gh(["issue", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", FIELDS]),
    gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--label",
      ALERT_LABEL,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      FIELDS,
    ]).catch(() => "[]"), // the label may not exist yet on a fresh repo
  ]);

  const byKey = new Map();
  for (const issue of [...JSON.parse(recent), ...JSON.parse(labelled)]) {
    const match = /<!-- pqp-monitor:([a-z0-9-]+) -->/.exec(issue.body ?? "");
    // Lowest number wins, so if duplicates ever do appear the original stays
    // the one being updated and closed rather than alternating between them.
    if (match && (byKey.get(match[1])?.number ?? Infinity) > issue.number) {
      byKey.set(match[1], issue);
    }
  }
  return byKey;
}

function body(result, runUrl) {
  const lines = [
    MARKER(result.key),
    "",
    `**${result.title}**`,
    "",
    result.summary,
    "",
  ];
  if (result.detail) {
    lines.push("```", String(result.detail).trim(), "```", "");
  }
  if (result.runbook) {
    lines.push("### What to do", result.runbook, "");
  }
  lines.push(
    [
      `_First seen ${new Date().toISOString()}.`,
      runUrl ? `[Run log](${runUrl}).` : "",
      "Closes itself when the check passes again — closing it by hand while the check is still failing just means the next run opens a new one._",
    ]
      .filter(Boolean)
      .join(" "),
  );
  return lines.join("\n");
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}

/**
 * @param {object} options
 * @param {string} options.repo         owner/name
 * @param {Array}  options.results      check results
 * @param {number} options.reminderHours minimum gap between nag comments
 * @param {string} [options.runUrl]     link back to the workflow run
 * @param {boolean} [options.dryRun]    print the actions, change nothing
 */
export async function reconcile({ repo, results, reminderHours, runUrl, dryRun = false }) {
  const actions = [];
  const existing = dryRun ? await openAlerts(repo).catch(() => new Map()) : await openAlerts(repo);
  if (!dryRun) {
    await ensureLabel(repo);
  }

  for (const result of results) {
    const issue = existing.get(result.key);

    if (result.status === "skip") {
      actions.push({ key: result.key, action: "ignored (skipped check)" });
      continue;
    }

    if (result.status === "ok") {
      if (!issue) {
        actions.push({ key: result.key, action: "no-op (healthy)" });
        continue;
      }
      actions.push({ key: result.key, action: `close #${issue.number}` });
      if (!dryRun) {
        await gh([
          "issue",
          "close",
          String(issue.number),
          "--repo",
          repo,
          "--reason",
          "completed",
          "--comment",
          `Recovered at ${new Date().toISOString()}.\n\n${result.summary}${
            runUrl ? `\n\n[Run log](${runUrl})` : ""
          }`,
        ]);
      }
      continue;
    }

    // fail or warn
    if (!issue) {
      const title = `[${result.status === "fail" ? "DOWN" : "WARN"}] ${result.title}`;
      actions.push({ key: result.key, action: `open issue "${title}"` });
      if (!dryRun) {
        await gh([
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--label",
          ALERT_LABEL,
          "--body",
          body(result, runUrl),
        ]);
      }
      continue;
    }

    const age = hoursSince(issue.updatedAt);
    if (age < reminderHours) {
      actions.push({
        key: result.key,
        action: `still failing, staying quiet (#${issue.number} touched ${age.toFixed(1)}h ago, threshold ${reminderHours}h)`,
      });
      continue;
    }
    actions.push({ key: result.key, action: `comment on #${issue.number}` });
    if (!dryRun) {
      await gh([
        "issue",
        "comment",
        String(issue.number),
        "--repo",
        repo,
        "--body",
        `Still failing as of ${new Date().toISOString()}.\n\n${result.summary}\n\n${
          result.detail ? `\`\`\`\n${String(result.detail).trim()}\n\`\`\`\n\n` : ""
        }${runUrl ? `[Run log](${runUrl})` : ""}`,
      ]);
    }
  }

  return actions;
}
