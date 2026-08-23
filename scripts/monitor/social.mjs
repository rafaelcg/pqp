/**
 * "Did we say something out there that is no longer true?"
 *
 * This group exists because of a specific incident: a published Reddit comment
 * was still telling people screen share had no audio, weeks after that stopped
 * being true. Nobody noticed for weeks, and it was found by chance rather than
 * by anything watching. The support bot fixes the inside of the product; this
 * fixes the outside.
 *
 * Same contract as the other groups: each check returns
 * `{ key, title, status, summary, detail?, runbook? }`, `key` is permanent
 * because it is the identity of the alert issue, and a check that cannot run is
 * `skip` — never a pass, so a missing credential can never look like health.
 *
 * THE ORDER OF VALUE HERE IS THE REVERSE OF THE ORDER OF EFFORT. `published-drift`
 * is the one that would have caught the actual incident, and it needs no
 * credential at all: it re-reads things we already posted and screens them
 * against the same `facts.md` the bot answers from. The mention checks are
 * nice-to-have discovery; the drift check is the one with a scar behind it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { httpGet, httpGetJson } from "./net.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/**
 * The fact file the bot answers from, reused verbatim.
 *
 * Imported rather than re-stated so there is exactly one definition of what is
 * true about this product. A second list here would drift from the first, and
 * the whole point of this check is to catch drift.
 */
const FACTS_PATH = join(REPO, "tools", "support-bot", "facts.md");

/** Where the things we have published are listed. See the header of that file. */
/**
 * Last meaningful path segment of a URL, used as the default proof-of-fetch
 * marker. Trailing slashes and a `.json` suffix are stripped so the same entry
 * works whichever form somebody pasted.
 */
export function lastSegment(url) {
  try {
    const path = new URL(url).pathname.replace(/\.json$/, "").replace(/\/+$/, "");
    const seg = path.split("/").filter(Boolean).pop() ?? "";
    return seg === "-" ? "" : seg;
  } catch {
    return "";
  }
}

const PUBLISHED_PATH = join(HERE, "published.json");

/** How far back a "new mention" counts. One day, matching the workflow cadence. */
const WINDOW_HOURS = Number(process.env.MONITOR_SOCIAL_WINDOW_HOURS ?? 24);

/**
 * Claims that were true once and are not any more, or were never true.
 *
 * Deliberately NOT generated from `## nunca diga`. That section is written as
 * instructions to a model ("nunca diga que...") and matching its prose against
 * a Reddit comment would fire on the instruction itself, which is the same trap
 * the fact-file loader already fell into once with the `4K` harvest. These are
 * written as the shape the CLAIM takes in the wild, in both languages, because
 * half of what we post is in English.
 *
 * `why` is shown in the alert. An alert that says "line 3 matched pattern 2" is
 * an alert nobody acts on.
 */
export const STALE_CLAIMS = [
  {
    id: "screen-share-has-no-audio",
    // THE ONE THAT HAPPENED. Screen share carries audio when you share a Chrome
    // tab with the box ticked; a flat "no audio" is now wrong.
    pattern:
      // The `\s+` after `sem` is not cosmetic: without it this read "semsom"
      // and missed "sem som", which is the single most natural way to write the
      // claim in Portuguese and therefore the way it would actually appear.
      /\b(sem\s+|n[ãa]o\s+(tem|leva|vai)\s+(o\s+)?)(som|[áa]udio)\b|\bno\s+(system\s+)?audio\b|\baudio\s+(is\s+)?not\s+supported\b/i,
    why: "Screen share DOES carry audio when sharing a Chrome/Edge tab with 'Também compartilhar áudio da guia' ticked. A flat 'no audio' has been wrong since that shipped.",
  },
  {
    id: "claims-e2e",
    pattern: /(ponta\s+a\s+ponta|end[\s-]?to[\s-]?end|\be2ee?\b)/i,
    negators: /\b(n[ãa]o|nunca|jamais|sem|not|no|never)\b/i,
    why: "pqp does not have end-to-end encryption. Any published claim that it does is the single highest-cost thing we could be saying.",
  },
  // DELIBERATELY ABSENT: "the desktop app cannot share a screen".
  //
  // It was here, and the facts.md cross-check retired it on the very first run,
  // correctly. The claim is true of v0.1.0 and false of v0.1.1, facts.md says
  // exactly that, and a regex over prose cannot tell which build a stranger's
  // comment is talking about. A claim that retires on every run is not
  // coverage, it is a row in a table that makes the table look bigger. If the
  // version nuance ever collapses — every published build can share a screen —
  // it is worth adding back.
  {
    id: "promises-app-store",
    pattern: /\bapp\s?store\b/i,
    negators: /\b(n[ãa]o|nunca|not|no)\b/i,
    why: "We never make claims about the App Store. TestFlight only.",
  },
];

/** How far back of a match a negator still counts, mirroring facts.js. */
const NEGATION_WINDOW = 60;

/**
 * Does `text` actually ASSERT this claim, rather than deny it?
 *
 * Shared shape with `assertsE2E` in the support bot's `facts.js`, and shared for
 * the same reason: "não tem criptografia de ponta a ponta" is us being honest,
 * and flagging it would train whoever reads these alerts to ignore them.
 */
export function asserts(text, claim) {
  const re = new RegExp(claim.pattern.source, claim.pattern.flags.replace("g", "") + "g");
  for (const match of String(text).matchAll(re)) {
    if (!claim.negators) {
      return match[0];
    }
    const before = text.slice(Math.max(0, match.index - NEGATION_WINDOW), match.index);
    if (!claim.negators.test(before)) {
      return match[0];
    }
  }
  return null;
}

/** Strip tags and entities so a pattern matches prose, not markup. */
function textOf(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Re-read everything we have published and screen it against today's facts.
 *
 * THE CHECK WITH A SCAR BEHIND IT. It needs no credential: these are public
 * URLs, fetched as anybody would fetch them. What it cannot do is discover a
 * post nobody wrote down, which is why `published.json` is a file a human
 * appends to and why an empty one is a `skip` with instructions rather than a
 * pass.
 */
async function checkPublishedDrift() {
  const key = "published-drift";
  const title = "Published posts still match facts.md";

  let entries;
  try {
    entries = JSON.parse(readFileSync(PUBLISHED_PATH, "utf8"));
  } catch (error) {
    return {
      key,
      title,
      status: "skip",
      summary: `Skipped: could not read ${PUBLISHED_PATH} (${error.message}).`,
    };
  }

  const live = entries.filter((e) => e && e.url && e.active !== false);
  if (live.length === 0) {
    return {
      key,
      title,
      status: "skip",
      summary:
        "Skipped: published.json has no entries. Add every Reddit comment, X post, HN " +
        "comment and forum reply we publish, as { url, where, note }. A post nobody " +
        "wrote down is a post this check cannot re-read.",
    };
  }

  // THE CROSS-CHECK, and the reason this reads facts.md at all.
  //
  // `STALE_CLAIMS` is hand-written; `facts.md` is the source of truth the
  // support bot answers from. They can disagree in one direction that matters:
  // a claim listed here as stale could become TRUE again — screen share audio
  // regressing, say — and this check would then keep flagging published posts
  // that are perfectly correct, which is how a monitor teaches you to ignore it.
  //
  // So before screening anything, ask the fact file. Any claim facts.md now
  // asserts is retired for this run and reported, rather than fired.
  let factsText = "";
  try {
    factsText = readFileSync(FACTS_PATH, "utf8");
  } catch (error) {
    return {
      key,
      title,
      status: "skip",
      summary:
        `Skipped: could not read ${FACTS_PATH} (${error.message}). This check screens ` +
        `published posts against the fact file, so without it there is nothing to screen against.`,
    };
  }

  const retired = STALE_CLAIMS.filter((c) => asserts(factsText, c));
  const claims = STALE_CLAIMS.filter((c) => !retired.includes(c));

  const findings = [];
  const unreachable = [];

  for (const entry of live) {
    let body;
    try {
      const res = await httpGet(entry.url, {
        timeoutMs: 15_000,
        // Reddit and X both serve a bot wall to a default agent. This is an
        // honest identifier, not a disguise.
        headers: { "user-agent": "pqp-monitor/1 (+https://pqp.gg)" },
      });
      if (res.status !== 200) {
        unreachable.push(`${entry.url} \u2014 HTTP ${res.status}`);
        continue;
      }
      body = textOf(res.body);

      // A 200 IS NOT PROOF WE READ THE POST, and on Reddit it usually is not.
      // `old.reddit.com/.../-/<id>` answers 200 with a 320KB "Welcome to
      // Reddit" login wall that contains none of the comment. Screening that
      // finds no stale claim and the check reports PASS, which is the worst
      // outcome available here: a green tick over a page we never read.
      //
      // So every entry must carry a `marker` that appears in its own body when
      // the fetch really worked. Default is the last path segment, which for a
      // Reddit comment permalink is the comment id and for most forums is the
      // slug. Absent it, this is unreachable, not clean.
      const marker = entry.marker ?? lastSegment(entry.url);
      if (marker && !body.toLowerCase().includes(marker.toLowerCase())) {
        unreachable.push(
          `${entry.url} \u2014 fetched 200 but the body did not contain "${marker}", ` +
            `so this is a wall or a redirect, not the post`,
        );
        continue;
      }
    } catch (error) {
      unreachable.push(`${entry.url} \u2014 ${error.message}`);
      continue;
    }

    for (const claim of claims) {
      const hit = asserts(body, claim);
      if (hit) {
        findings.push(
          `${entry.where ?? "post"}: ${entry.url}\n  claim: ${claim.id} (matched "${hit.trim().slice(0, 60)}")\n  why:   ${claim.why}`,
        );
      }
    }
  }

  if (findings.length > 0) {
    return {
      key,
      title,
      status: "fail",
      summary: `${findings.length} published item(s) assert something facts.md contradicts.`,
      detail: findings.join("\n\n"),
      runbook:
        "Edit or delete the post. Then decide whether facts.md needs the same correction, " +
        "and whether tools/support-bot answers it correctly today.",
    };
  }

  if (unreachable.length > 0) {
    return {
      key,
      title,
      status: "warn",
      summary: `${live.length - unreachable.length}/${live.length} readable; ${unreachable.length} could not be fetched.`,
      detail: unreachable.join("\n"),
      runbook:
        "A 403 usually means the platform is blocking a plain fetch, not that the post is gone. " +
        "Check by hand before assuming it was deleted.",
    };
  }

  const note =
    retired.length > 0
      ? ` ${retired.length} claim(s) retired because facts.md now asserts them: ${retired
          .map((c) => c.id)
          .join(", ")}.`
      : "";

  return {
    key,
    title,
    status: "ok",
    summary: `All ${live.length} published item(s) still agree with facts.md.${note}`,
  };
}

/**
 * Pull `<entry>` blocks out of Reddit's Atom feed.
 *
 * A regex rather than an XML dependency: this repo has no XML parser, the feed
 * is machine-generated and boringly regular, and the failure mode of a missed
 * entry is a mention nobody was going to see anyway. Adding a dependency to the
 * monitor - the one thing that has to keep working when everything else is
 * broken - is the worse trade.
 */
function parseAtom(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => {
    const pick = (re) => (entry.match(re)?.[1] ?? "").trim();
    return {
      title: pick(/<title[^>]*>([\s\S]*?)<\/title>/),
      link: pick(/<link[^>]*href="([^"]+)"/),
      updated: pick(/<updated>([^<]+)<\/updated>/),
      author: pick(/<name>([^<]+)<\/name>/),
      category: pick(/<category[^>]*term="([^"]+)"/),
    };
  });
}

/**
 * Anybody talking about us on Reddit, in the last day.
 *
 * Unauthenticated on purpose: a check that works today beats one that waits on
 * an API application. It is `warn`, never `fail` - a mention is something to go
 * and read, not a fault. The alert issue is the inbox.
 *
 * IT USES THE RSS FEED, NOT `search.json`. Reddit now answers anonymous calls to
 * `/search.json` with a flat 403, and `old.reddit.com` 302s to a login page, so
 * the obvious endpoint and the obvious fallback are both dead. `/search.rss`
 * still answers 200 without a credential. It is rate-limited hard - a second
 * call seconds later gets 429 - which is survivable precisely because this runs
 * once a day.
 */
async function checkRedditMentions() {
  const key = "reddit-mentions";
  const title = "Reddit mentions of pqp.gg";
  const query = process.env.MONITOR_SOCIAL_QUERY ?? "pqp.gg";

  let res;
  try {
    res = await httpGet(
      `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=new&t=week`,
      {
        timeoutMs: 20_000,
        headers: { "user-agent": "pqp-monitor/1 (+https://pqp.gg)" },
      },
    );
  } catch (error) {
    return {
      key,
      title,
      status: "skip",
      summary: `Skipped: Reddit search failed (${error.message}).`,
    };
  }

  if (res.status !== 200) {
    // 429 and 403 are both "could not run", never a clean bill of health. A
    // silent pass here is exactly how a monitor lies.
    return {
      key,
      title,
      status: "skip",
      summary:
        `Skipped: Reddit answered HTTP ${res.status}. Anonymous access is rate-limited ` +
        `and it usually works on the next daily run. A persistent 403 means the RSS ` +
        `path has been closed too, and this check then needs an OAuth app.`,
    };
  }

  const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000;
  const fresh = parseAtom(res.body).filter((e) => {
    const at = Date.parse(e.updated);
    return Number.isFinite(at) && at >= cutoff;
  });

  if (fresh.length === 0) {
    return {
      key,
      title,
      status: "ok",
      summary: `No new Reddit mentions of "${query}" in the last ${WINDOW_HOURS}h.`,
    };
  }

  return {
    key,
    title,
    status: "warn",
    summary: `${fresh.length} new Reddit mention(s) of "${query}" in the last ${WINDOW_HOURS}h.`,
    detail: fresh
      .map((e) => `${e.category || "reddit"} — ${e.title}\n  ${e.link}\n  by ${e.author}, ${e.updated}`)
      .join("\n\n"),
    runbook:
      "Read them. Reply where it helps and where we are not the loudest voice in the thread. " +
      "If a reply states a product fact, check it against tools/support-bot/facts.md first, " +
      "and add the permalink to scripts/monitor/published.json so it is re-checked from then on.",
  };
}

/**
 * Mentions of the X account.
 *
 * X has no usable anonymous read path, so this is `skip` without a token rather
 * than a check that quietly always passes. The free tier does not include
 * recent search either, which is worth stating in the skip message so nobody
 * spends an afternoon rediscovering it.
 */
async function checkXMentions() {
  const key = "x-mentions";
  const title = "X mentions of @pqpdotgg";
  const token = process.env.X_BEARER_TOKEN;
  const handle = process.env.MONITOR_X_HANDLE ?? "pqpdotgg";

  if (!token) {
    return {
      key,
      title,
      status: "skip",
      summary:
        "Skipped: X_BEARER_TOKEN is not set. X has no anonymous read path, and recent search " +
        "is not on the free API tier — this needs a paid plan before it can run at all.",
    };
  }

  try {
    const data = await httpGetJson(
      `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(
        `@${handle} -is:retweet`,
      )}&max_results=25&tweet.fields=created_at,author_id`,
      { timeoutMs: 15_000, headers: { authorization: `Bearer ${token}` } },
    );
    const items = data?.data ?? [];
    if (items.length === 0) {
      return { key, title, status: "ok", summary: `No recent X mentions of @${handle}.` };
    }
    return {
      key,
      title,
      status: "warn",
      summary: `${items.length} recent X mention(s) of @${handle}.`,
      detail: items
        .map((t) => `https://x.com/i/status/${t.id}\n  ${String(t.text).slice(0, 180)}`)
        .join("\n\n"),
      runbook: "Reply where it helps. Check any product claim against facts.md first.",
    };
  } catch (error) {
    return {
      key,
      title,
      status: "skip",
      summary: `Skipped: X search failed (${error.message}).`,
    };
  }
}

export async function runSocialChecks() {
  // Sequential rather than parallel: these hit two rate-limited public APIs and
  // there is no deadline worth racing here.
  return [
    await checkPublishedDrift(),
    await checkRedditMentions(),
    await checkXMentions(),
  ];
}

/**
 * The parts no credential fixes, printed on every run so the gap stays visible.
 * Same convention as `LIMITS_NOT_AUTOMATED`.
 */
export const SOCIAL_NOT_AUTOMATED = [
  {
    what: "Reddit inbox (replies to our comments)",
    limit: "needs an OAuth app and a refresh token",
    why: "The unauthenticated API cannot read an account's inbox. Until then, reddit.com/message/unread is a manual check.",
    cadence: "daily while we are actively posting",
  },
  {
    what: "Whether a reply was appropriate",
    limit: "n/a",
    why: "This group checks that what we said is still TRUE. It cannot judge tone, or whether replying at all was a good idea.",
    cadence: "every time, by a person",
  },
];
