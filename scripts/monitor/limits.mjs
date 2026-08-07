/**
 * "Is it about to cost me / hit a wall?" — the checks that run once a day.
 *
 * Ground rules for this file:
 *   * every threshold cites where the limit came from, in a comment. A guessed
 *     quota is a fake alert waiting to happen;
 *   * a check that cannot run returns `skip` with the exact credential needed,
 *     never a silent pass. `LIMITS_NOT_AUTOMATED` at the bottom carries the
 *     things no credential can fix, and it is printed on every run so the gap
 *     stays visible instead of being forgotten in a doc.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { httpGet, httpGetJson, httpPostJson, tlsCertificate, whois } from "./net.mjs";

const exec = promisify(execFile);

/**
 * Alert on a certificate this close to expiry. 21 days is chosen against the
 * renewal cadence, not picked round: both issuers here renew at 30 days out,
 * so 21 means "one automatic attempt has already been missed".
 */
const TLS_WARN_DAYS = Number(process.env.MONITOR_TLS_WARN_DAYS ?? 21);
const TLS_FAIL_DAYS = Number(process.env.MONITOR_TLS_FAIL_DAYS ?? 7);

/** Quota checks alert here. Two levels so "keep an eye on it" != "act today". */
const WARN_FRACTION = Number(process.env.MONITOR_WARN_FRACTION ?? 0.7);
const FAIL_FRACTION = Number(process.env.MONITOR_FAIL_FRACTION ?? 0.85);

const TLS_HOSTS = (process.env.MONITOR_TLS_HOSTS ?? "pqp.gg,www.pqp.gg,api.pqp.gg")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

function pct(used, limit) {
  return `${((used / limit) * 100).toFixed(1)}%`;
}

function levelFor(used, limit) {
  const fraction = used / limit;
  if (fraction >= FAIL_FRACTION) return "fail";
  if (fraction >= WARN_FRACTION) return "warn";
  return "ok";
}

/**
 * TLS expiry for all three hostnames.
 *
 * Both issuers here renew automatically — Cloudflare (Google Trust Services)
 * for pqp.gg and www, Fly (Let's Encrypt) for api — so this should never fire.
 * That is the point: it fires only when automatic renewal has stopped working,
 * which is a silent failure with a hard deadline, and 21 days is enough runway
 * to fix a DNS validation problem by hand.
 */
async function checkTlsExpiry() {
  const rows = [];
  let worst = "ok";
  for (const host of TLS_HOSTS) {
    try {
      const cert = await tlsCertificate(host, { timeoutMs: 15_000 });
      const level =
        cert.daysRemaining <= TLS_FAIL_DAYS
          ? "fail"
          : cert.daysRemaining <= TLS_WARN_DAYS
            ? "warn"
            : "ok";
      if (level === "fail" || (level === "warn" && worst === "ok")) worst = level;
      rows.push(
        `${host}: ${cert.daysRemaining}d left (expires ${cert.expiresAt.toISOString().slice(0, 10)}, issuer ${cert.issuer})`,
      );
    } catch (error) {
      // A handshake that fails outright is worse than one about to expire.
      worst = "fail";
      rows.push(`${host}: TLS FAILED — ${error.message}`);
    }
  }
  return {
    key: "tls-expiry",
    title: `TLS certificates (warn at ${TLS_WARN_DAYS} days)`,
    status: worst,
    summary:
      worst === "ok"
        ? `All certificates valid for more than ${TLS_WARN_DAYS} days.`
        : "A certificate is close to expiry or failed to negotiate.",
    detail: rows.join("\n"),
    runbook: [
      "pqp.gg / www.pqp.gg are Cloudflare Universal SSL — check the zone's SSL/TLS > Edge Certificates page; renewal fails when the domain stops pointing at Cloudflare's nameservers.",
      "api.pqp.gg is Fly-managed Let's Encrypt — `fly certs show api.pqp.gg -a pqp-api` and `fly certs check api.pqp.gg -a pqp-api`.",
    ].join("\n"),
  };
}

/**
 * The registration itself, via WHOIS at whois.gg.
 *
 * `.gg` has NO RDAP service (it does not appear in data.iana.org/rdap/dns.json),
 * so the modern JSON API is not an option and this parses text. The registry
 * also does not publish an expiry date: `.gg` registrations are "registered
 * until cancelled" with a registry fee due annually on the anniversary. So
 * there is no countdown to read — what there IS, and what actually matters, is
 * the domain's status. Auto-renew failing (an expired card at Porkbun, which
 * is the normal way a domain gets lost) shows up here as the status leaving
 * "Active" long before the name stops resolving.
 *
 * The nameserver check rides along free: if these ever stop being Cloudflare's,
 * either the domain was hijacked or someone changed them by accident, and both
 * are worth waking up for.
 */
/**
 * whois.gg answers in indented blocks under `Label:` headings, with line
 * endings that mix LF and CRLF inside a single response. Parsing it with one
 * regex per field is how this check produced its first false alarm — it read
 * an empty status block and reported the domain as not Active.
 *
 * So: normalise the line endings, split into labelled sections once, and read
 * fields out of that. A parse that finds nothing is treated as `skip` by the
 * caller, never as a failure — a registry changing its output format must not
 * look like a lost domain.
 */
function parseWhoisSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (/^\S.*:\s*$/.test(line)) {
      current = line.replace(/:\s*$/, "").trim();
      sections.set(current, []);
    } else if (current && /^\s+\S/.test(line)) {
      sections.get(current).push(line.trim());
    } else {
      // A blank line, or free-text boilerplate, ends the current section.
      current = null;
    }
  }
  return sections;
}

async function checkDomainRegistration() {
  const domain = process.env.MONITOR_DOMAIN ?? "pqp.gg";
  let text;
  try {
    text = await whois(domain, { host: "whois.gg", timeoutMs: 20_000 });
  } catch (error) {
    return {
      key: "domain-registration",
      title: `Domain registration (${domain})`,
      status: "skip",
      summary: `WHOIS lookup failed: ${error.message}. Port 43 may be blocked from this network.`,
    };
  }

  // Unambiguous, and catastrophic: the registry does not know this name. Not
  // folded into the "could not parse" branch below, because "the format
  // changed" and "the domain is gone" must not share an outcome.
  if (/^\s*NOT FOUND\s*$/im.test(text)) {
    return {
      key: "domain-registration",
      title: `Domain registration (${domain})`,
      status: "fail",
      summary: `The registry does not know ${domain} — it is unregistered or has been deleted.`,
      detail: text.slice(0, 300),
      runbook:
        "Go to porkbun.com immediately. A .gg name that lapses can be re-registered by anyone, and the whole deployment (Clerk origins, Cloudflare zone, Fly certificate) is keyed to this name.",
    };
  }

  const sections = parseWhoisSections(text);
  const statusLines = sections.get("Domain Status") ?? [];
  const nameservers = sections.get("Name servers") ?? [];
  const registrar = (sections.get("Registrar") ?? [])[0] ?? "unknown";

  if (statusLines.length === 0 || nameservers.length === 0) {
    return {
      key: "domain-registration",
      title: `Domain registration (${domain})`,
      status: "skip",
      summary:
        "Skipped: the WHOIS response did not contain a Domain Status or Name servers block. Either the registry changed its output format or the lookup was truncated — check by hand with `whois -h whois.gg pqp.gg` before assuming anything is wrong.",
      detail: text.slice(0, 500),
    };
  }

  const active = statusLines.some((line) => /^Active$/i.test(line));
  const onCloudflare = nameservers.every((ns) => ns.endsWith(".ns.cloudflare.com"));

  // The annual registry fee date, read from WHOIS rather than hardcoded so it
  // stays right if the domain is ever transferred. Warn inside a 30-day window
  // before it: that is the moment to confirm the card on file is still valid,
  // which is the actual failure this protects against.
  const feeDay = /Registry fee due on (\d{1,2})\w{2} (\w+) each year/.exec(text);
  let feeNote = "no annual fee date found in WHOIS";
  let feeSoon = false;
  if (feeDay) {
    const month = new Date(`${feeDay[2]} 1, 2000`).getMonth();
    const now = new Date();
    let next = new Date(Date.UTC(now.getUTCFullYear(), month, Number(feeDay[1])));
    if (next < now) next = new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(feeDay[1])));
    const days = Math.round((next - now) / 86_400_000);
    feeSoon = days <= 30;
    feeNote = `registry fee due in ${days} days (${next.toISOString().slice(0, 10)})`;
  }

  const status = !active ? "fail" : !onCloudflare ? "fail" : feeSoon ? "warn" : "ok";
  return {
    key: "domain-registration",
    title: `Domain registration (${domain})`,
    status,
    summary: active
      ? onCloudflare
        ? feeSoon
          ? `Active, but ${feeNote} — confirm the payment card at ${registrar} is still valid.`
          : `Active at ${registrar}, nameservers on Cloudflare, ${feeNote}.`
        : `NAMESERVERS ARE NOT CLOUDFLARE: ${nameservers.join(", ")}`
      : `Domain status is not Active: ${statusLines.join("; ")}`,
    detail: [`registrar: ${registrar}`, `nameservers: ${nameservers.join(", ")}`, feeNote].join(
      "\n",
    ),
    runbook: [
      "`.gg` has no fixed expiry date — it is 'registered until cancelled' with an annual registry fee. Auto-renew is on at Porkbun, and the way it fails is an expired card, not a forgotten date.",
      "Log in to porkbun.com, confirm the payment method and that auto-renew is still enabled for pqp.gg.",
      "If the status left 'Active', treat it as urgent: resolution stops within days and re-registration is not guaranteed.",
    ].join("\n"),
  };
}

/**
 * Postgres volume usage against the 10 GB provisioned by Fly Managed Postgres.
 *
 * The 10 GB figure is not guessed: `fly mpg status <cluster> --json` reports
 * `"disk": 10` for this cluster (the Basic plan's volume, in GB).
 *
 * There is no usage field in that output, so the size has to come from the
 * database itself — and the cluster only has a private 6PN address
 * (`fdaa:…`), unreachable from a GitHub runner without a tunnel. Hence
 * `fly mpg proxy` + psql. Two consequences worth knowing:
 *   * this needs an ORG-scoped Fly token. The FLY_API_TOKEN used for deploys is
 *     app-scoped (`fly tokens create deploy -a pqp-api`) and cannot read an MPG
 *     cluster, so the check reports `skip` rather than pretending;
 *   * the query is `pg_database_size`, which is read-only.
 */
async function checkPostgresSize() {
  const cluster = process.env.MONITOR_MPG_CLUSTER;
  if (!cluster) {
    return {
      key: "postgres-disk",
      title: "Postgres volume usage",
      status: "skip",
      summary:
        "Skipped: MONITOR_MPG_CLUSTER is not set. Find it with `fly mpg list --org <org>` and set it as a repository variable.",
    };
  }
  if (!process.env.FLY_API_TOKEN && !process.env.MONITOR_FLY_LOCAL) {
    return {
      key: "postgres-disk",
      title: "Postgres volume usage",
      status: "skip",
      summary: "Skipped: no Fly credential.",
    };
  }

  let status;
  try {
    const { stdout } = await exec("flyctl", ["mpg", "status", cluster, "--json"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    status = JSON.parse(stdout);
  } catch (error) {
    return {
      key: "postgres-disk",
      title: "Postgres volume usage",
      status: "skip",
      summary:
        "Skipped: `fly mpg status` failed. The deploy token is app-scoped and cannot read the database cluster — this needs an org-scoped token (`fly tokens create org --name pqp-monitor`) stored as FLY_API_TOKEN or FLY_ORG_TOKEN.",
      detail: error.message,
    };
  }

  const limitGb = status?.data?.disk;
  const creds = status?.credentials;
  if (!limitGb || !creds?.password) {
    return {
      key: "postgres-disk",
      title: "Postgres volume usage",
      status: "skip",
      summary: "Skipped: `fly mpg status --json` did not include a disk size and credentials.",
    };
  }

  const port = Number(process.env.MONITOR_MPG_PORT ?? 16543);
  const proxy = exec("flyctl", ["mpg", "proxy", cluster, "--local-port", String(port)]);
  try {
    // The tunnel is a WireGuard peer flyctl brings up in userspace; it takes a
    // few seconds before the local port answers.
    await new Promise((r) => setTimeout(r, 12_000));
    const { stdout } = await exec(
      "psql",
      [
        "--no-psqlrc",
        "-t",
        "-A",
        "-c",
        "SELECT pg_database_size(current_database())",
        `postgresql://${creds.user}:${encodeURIComponent(creds.password)}@127.0.0.1:${port}/${creds.dbname}`,
      ],
      { env: { ...process.env, PGCONNECT_TIMEOUT: "15" } },
    );
    const bytes = Number(stdout.trim());
    const usedGb = bytes / 1024 ** 3;
    const level = levelFor(usedGb, limitGb);
    return {
      key: "postgres-disk",
      title: `Postgres volume usage (${limitGb} GB provisioned)`,
      status: level,
      summary: `${usedGb.toFixed(3)} GB of ${limitGb} GB used (${pct(usedGb, limitGb)}).`,
      detail: `pg_database_size(${creds.dbname}) = ${bytes} bytes`,
      runbook: [
        "The retention sweeps in server/src/index.ts already prune audit logs, reports and status samples. If this is climbing anyway, the growth is message history or message_attachments rows.",
        "`fly mpg connect <cluster>` then: SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;",
        "Growing the volume is a Fly plan change, not a flag.",
      ].join("\n"),
    };
  } catch (error) {
    return {
      key: "postgres-disk",
      title: "Postgres volume usage",
      status: "skip",
      summary: `Skipped: could not query through the tunnel (${error.message.slice(0, 200)}). psql must be on PATH.`,
    };
  } finally {
    proxy.child.kill("SIGTERM");
    await proxy.catch(() => {});
  }
}

/**
 * R2 free tier, from https://developers.cloudflare.com/r2/pricing/ :
 *   storage             10 GB-month / month
 *   Class A (writes)     1,000,000 requests / month
 *   Class B (reads)     10,000,000 requests / month
 *   egress               free, always — so there is nothing to watch there
 *
 * Read through the GraphQL analytics API, month to date. Needs a token with
 * "Account Analytics: Read"; a token that only has R2 read cannot answer this,
 * so a 403 here is reported as a `skip` naming the permission rather than as a
 * failure.
 */
async function checkR2Usage() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    return {
      key: "r2-usage",
      title: "Cloudflare R2 free tier",
      status: "skip",
      summary: "Skipped: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set.",
    };
  }

  const now = new Date();
  // R2 analytics are retained for 31 days, so month-to-date always fits.
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const nowIso = now.toISOString();

  // Field names follow the documented schema exactly
  // (developers.cloudflare.com/r2/platform/metrics-analytics/): the filter is
  // `datetime_geq` / `datetime_leq` over `Time`, NOT a `date` field. Getting
  // this wrong does not produce a wrong number — it produces a GraphQL error,
  // which this check reports as `skip`, i.e. a quota silently stops being
  // watched. Hence the care.
  const query = `
    query R2Usage($accountTag: String!, $start: Time, $end: Time) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          storage: r2StorageAdaptiveGroups(
            limit: 1
            filter: { datetime_geq: $start, datetime_leq: $end }
            orderBy: [datetime_DESC]
          ) {
            max { payloadSize metadataSize objectCount }
            dimensions { datetime }
          }
          ops: r2OperationsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }`;

  const res = await httpPostJson(
    "https://api.cloudflare.com/client/v4/graphql",
    { query, variables: { accountTag: accountId, start: monthStart, end: nowIso } },
    { headers: { authorization: `Bearer ${token}` } },
  );

  const errors = res.json?.errors;
  if (res.status !== 200 || errors) {
    return {
      key: "r2-usage",
      title: "Cloudflare R2 free tier",
      status: "skip",
      summary:
        "Skipped: the Cloudflare analytics query was refused (see detail). Code 9106 means the token itself was rejected; a permission error means CLOUDFLARE_API_TOKEN is valid but is missing 'Account Analytics: Read' — which it needs in addition to R2 read.",
      detail: `HTTP ${res.status}: ${JSON.stringify(errors ?? res.body).slice(0, 400)}`,
    };
  }

  const account = res.json?.data?.viewer?.accounts?.[0];
  const storage = account?.storage?.[0]?.max;
  const storedGb = storage ? (storage.payloadSize + storage.metadataSize) / 1024 ** 3 : 0;

  // Cloudflare's own mapping of actionType to billing class. Anything that
  // mutates or lists is Class A; plain reads are Class B.
  const CLASS_A = new Set([
    "ListBuckets",
    "PutBucket",
    "ListObjects",
    "PutObject",
    "CopyObject",
    "CompleteMultipartUpload",
    "CreateMultipartUpload",
    "UploadPart",
    "UploadPartCopy",
    "ListMultipartUploads",
    "PutBucketEncryption",
    "PutBucketCors",
    "PutBucketLifecycleConfiguration",
    "LifecycleStorageTierTransition",
  ]);
  let classA = 0;
  let classB = 0;
  for (const group of account?.ops ?? []) {
    const n = group.sum.requests;
    if (CLASS_A.has(group.dimensions.actionType)) classA += n;
    else classB += n;
  }

  const levels = [
    levelFor(storedGb, 10),
    levelFor(classA, 1_000_000),
    levelFor(classB, 10_000_000),
  ];
  const status = levels.includes("fail") ? "fail" : levels.includes("warn") ? "warn" : "ok";
  const rows = [
    `storage:  ${storedGb.toFixed(3)} GB of 10 GB (${pct(storedGb, 10)})`,
    `class A:  ${classA.toLocaleString()} of 1,000,000 (${pct(classA, 1_000_000)})`,
    `class B:  ${classB.toLocaleString()} of 10,000,000 (${pct(classB, 10_000_000)})`,
    `window:   ${monthStart.slice(0, 10)} .. ${nowIso.slice(0, 10)} (storage is the latest sample, not a GB-month average)`,
  ];
  return {
    key: "r2-usage",
    title: "Cloudflare R2 free tier (month to date)",
    status,
    summary: status === "ok" ? `Within the free tier. ${rows[0]}` : `Approaching the R2 free tier.`,
    detail: rows.join("\n"),
    runbook: [
      "Storage is the one that bites: it is a standing quantity, not a monthly reset. The attachment sweeper in server/src/index.ts deletes unclaimed objects; orphaned claimed ones are not swept.",
      "Egress is free on R2 at every tier, so serving attachments costs nothing regardless of traffic.",
      "Past the free tier: $0.015/GB-month, $4.50 per million Class A, $0.36 per million Class B.",
    ].join("\n"),
  };
}

/**
 * Cloudflare Pages free plan: 500 builds/month, 1 concurrent build
 * (https://developers.cloudflare.com/pages/platform/limits/).
 *
 * Counted from the deployments list rather than a usage endpoint, because
 * Cloudflare does not expose a build counter. Needs a token with
 * "Cloudflare Pages: Read".
 */
async function checkPagesBuilds() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const project = process.env.MONITOR_PAGES_PROJECT ?? "pqp";
  if (!accountId || !token) {
    return {
      key: "pages-builds",
      title: "Cloudflare Pages builds",
      status: "skip",
      summary: "Skipped: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set.",
    };
  }

  const monthStart = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  ).getTime();
  let deployments = [];
  try {
    // 100 per page is the API maximum; 500 builds is 5 pages, and the list is
    // newest-first so we stop as soon as we walk past the start of the month.
    for (let page = 1; page <= 6; page += 1) {
      const { json } = await httpGetJson(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}/deployments?per_page=100&page=${page}`,
        { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20_000 },
      );
      const batch = json.result ?? [];
      deployments.push(...batch);
      if (batch.length < 100) break;
      if (new Date(batch[batch.length - 1].created_on).getTime() < monthStart) break;
    }
  } catch (error) {
    return {
      key: "pages-builds",
      title: "Cloudflare Pages builds",
      status: "skip",
      summary:
        "Skipped: could not list Pages deployments (see detail). Code 9106 means the token was rejected; a 403 means CLOUDFLARE_API_TOKEN needs 'Cloudflare Pages: Read' on this account.",
      detail: error.message,
    };
  }

  const thisMonth = deployments.filter(
    (d) => new Date(d.created_on).getTime() >= monthStart,
  ).length;
  const failed = deployments.filter(
    (d) =>
      new Date(d.created_on).getTime() >= monthStart &&
      d.latest_stage?.status === "failure",
  ).length;
  const level = levelFor(thisMonth, 500);
  return {
    key: "pages-builds",
    title: "Cloudflare Pages builds (500/month on the free plan)",
    status: level,
    summary: `${thisMonth} builds this month of 500 (${pct(thisMonth, 500)}); ${failed} failed.`,
    detail: `project: ${project}`,
    runbook:
      "Every push to main that touches the client triggers a build. If this is climbing, narrow the deploy workflow's path filters.",
  };
}

/**
 * Clerk. The production instance was created 2026-08-07.
 *
 * The free Hobby plan allows 50,000 MRU per app — monthly RETAINED users, a
 * narrower unit than MAU: a user only counts once they return at least 24h
 * after signing up (https://clerk.com/pricing). There is no MRU endpoint in
 * the Backend API, so this counts total users instead. That is a deliberately
 * conservative proxy: total users >= MRU always, so it can warn early but it
 * cannot miss. 50,000 is far enough away that this is a formality; it exists so
 * that if pqp ever does take off, the bill is not the way anyone finds out.
 */
async function checkClerkUsers() {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) {
    return {
      key: "clerk-users",
      title: "Clerk user count",
      status: "skip",
      summary:
        "Skipped: CLERK_SECRET_KEY is not available to CI (it lives only as a Fly secret). Optional — the free plan allows 50,000 monthly retained users, so this is a long way off.",
    };
  }
  try {
    const { json } = await httpGetJson("https://api.clerk.com/v1/users/count", {
      headers: { authorization: `Bearer ${secret}` },
      timeoutMs: 20_000,
    });
    const total = json.total_count ?? 0;
    const level = levelFor(total, 50_000);
    return {
      key: "clerk-users",
      title: "Clerk users (free plan: 50,000 monthly retained users)",
      status: level,
      summary: `${total.toLocaleString()} total users; the free plan covers 50,000 monthly retained users (${pct(total, 50_000)} of that ceiling by the conservative total-users proxy).`,
    };
  } catch (error) {
    return {
      key: "clerk-users",
      title: "Clerk user count",
      status: "skip",
      summary: `Skipped: Clerk API call failed (${error.message.slice(0, 160)}).`,
    };
  }
}

/**
 * A signal that costs one unauthenticated request: has any component probe
 * been failing over the last day, even if it is fine right now?
 *
 * The 10-minute availability check only sees the instant it runs. A dependency
 * that flaps for two minutes every hour never gets caught by it and never
 * opens an issue — but it shows up here as 24h uptime below the threshold.
 */
async function checkRecentUptime() {
  const origin = process.env.MONITOR_API_ORIGIN ?? "https://api.pqp.gg";
  const floor = Number(process.env.MONITOR_UPTIME_FLOOR ?? 0.99);
  const res = await httpGet(`${origin}/status.json`, { timeoutMs: 15_000 });
  if (res.status !== 200) {
    return {
      key: "uptime-24h",
      title: "24h component uptime",
      status: "skip",
      summary: `Skipped: /status.json answered HTTP ${res.status} (the availability check owns that failure).`,
    };
  }
  const summary = JSON.parse(res.body);
  const measured = summary.components.filter(
    (c) => c.state !== "disabled" && typeof c.uptime24h === "number",
  );
  const below = measured.filter((c) => c.uptime24h < floor);
  return {
    key: "uptime-24h",
    title: `24h component uptime (floor ${(floor * 100).toFixed(1)}%)`,
    status: below.length ? "warn" : "ok",
    summary: below.length
      ? `Below the floor: ${below.map((c) => `${c.label} ${(c.uptime24h * 100).toFixed(2)}%`).join(", ")}`
      : `All components at or above ${(floor * 100).toFixed(1)}% over 24h.`,
    detail: measured
      .map((c) => `${c.key}: 24h ${(c.uptime24h * 100).toFixed(2)}%, 7d ${(c.uptime7d * 100).toFixed(2)}%`)
      .join("\n"),
    runbook:
      "This means something flapped rather than fell over. `fly logs -a pqp-api` around the dips; the per-minute samples are in the status_samples table if you need the exact times.",
  };
}

/**
 * Printed on every run. These are not checks — they are the honest edge of the
 * automation, kept next to the code so they cannot drift out of the docs.
 */
export const LIMITS_NOT_AUTOMATED = [
  {
    what: "ExpressTURN relay bandwidth",
    limit: "1,000 GB / month on the free tier (expressturn.com)",
    why: "ExpressTURN publishes no usage API and issues no API key — the only reading is the account page at expressturn.com.",
    cadence: "monthly, and after any busy voice weekend",
  },
  {
    what: "GitHub Actions minutes",
    limit: "unlimited",
    why: "rafaelcg/pqp is a PUBLIC repository, and Actions minutes are free and unmetered for public repos. There is no quota to hit, so no alert is built for it. It becomes a real limit only if the repo is ever made private.",
    cadence: "never, unless the repo goes private",
  },
  {
    what: "LiveKit Cloud participant-minutes",
    limit: "n/a",
    why: "LIVEKIT_* is not configured — voice is full-mesh, so there is no SFU account to meter. Add a check here if that changes.",
    cadence: "n/a until LiveKit is configured",
  },
  {
    what: "Fly bandwidth and machine hours",
    limit: "billed usage, no free-tier wall",
    why: "Fly bills usage rather than cutting off, so the failure mode is a surprise invoice, not an outage. Fly's own spend-alert setting handles it better than a probe could.",
    cadence: "set a spend alert once in the Fly dashboard, then monthly glance",
  },
  {
    what: "Clerk MRU (as opposed to total users)",
    limit: "50,000 monthly retained users on the free plan",
    why: "Clerk's Backend API exposes a user count but not an MRU count. The automated check uses total users as a conservative proxy; the real number is on the Clerk dashboard.",
    cadence: "quarterly",
  },
];

export async function runLimitChecks() {
  const checks = [
    ["tls-expiry", checkTlsExpiry],
    ["domain-registration", checkDomainRegistration],
    ["postgres-disk", checkPostgresSize],
    ["r2-usage", checkR2Usage],
    ["pages-builds", checkPagesBuilds],
    ["clerk-users", checkClerkUsers],
    ["uptime-24h", checkRecentUptime],
  ];
  const results = [];
  for (const [key, check] of checks) {
    try {
      results.push(await check());
    } catch (error) {
      results.push({
        key,
        title: key,
        status: "skip",
        summary: `Check threw: ${error.message}`,
      });
    }
  }
  return results;
}
