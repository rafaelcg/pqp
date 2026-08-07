/**
 * Image safety scanning.
 *
 * ============================== THE CONSTRAINT ==============================
 *
 * Object bytes never pass through this process. The browser PUTs straight to
 * the bucket and every read is a presigned GET; the API's entire relationship
 * with an attachment's content is a HEAD for its size. Pulling 10 MiB into a
 * Railway container to post it at a classifier would undo the one property the
 * whole attachment design exists to preserve.
 *
 * So nothing here reads an image. Every provider is handed a short-lived
 * presigned GET and fetches the object itself, from the bucket, over the same
 * public edge a browser would use. The API moves a URL and a verdict, which are
 * both a few hundred bytes.
 *
 * =============================== WHERE IT RUNS ==============================
 *
 * On the send path, in `verifyPendingAttachments`, concurrently with the HEAD
 * that already happens there. Three properties come out of that placement and
 * no other placement has all three:
 *
 *   - NO TRANSACTION IS OPEN. `createMessage` documents the rule this obeys:
 *     nothing between BEGIN and COMMIT may touch the network, because a bucket
 *     that blackholes packets would otherwise park pooled connections
 *     idle-in-transaction and turn a storage outage into an API outage. The
 *     verify step is already outside the transaction for exactly this reason,
 *     so a scan costs the same kind of round trip that is already there.
 *   - THE IMAGE HAS NEVER BEEN VISIBLE. An attachment is invisible until a
 *     message claims it — unclaimed rows are hidden even from their uploader.
 *     Scanning before the claim means the window in which unsafe content is
 *     readable by anybody is zero. Every asynchronous design (scan after claim,
 *     R2 event notification, a queue) trades that window away, and the window
 *     is the entire point.
 *   - FAILURE IS ALREADY DEFINED. An attachment that fails verification is
 *     dropped from the message and left for the sweeper. A scan that says no is
 *     the same event as a HEAD that says no, and needs no new semantics.
 *
 * What it costs is latency on the send, bounded by `CONTENT_SCAN_TIMEOUT_MS`
 * (default 6s) and paid only by messages that carry a freshly uploaded image.
 * The timeout is the "never block on a slow third party" rule: a provider that
 * hangs is a provider that answered `error` six seconds ago.
 *
 * ============================== FAIL CLOSED =================================
 *
 * There are two different unconfigured-ish states and conflating them is how
 * this kind of code ends up lying:
 *
 *   NO PROVIDER CONFIGURED — the feature is off, exactly like S3 with no
 *   `S3_*`. Attachments go through and are recorded `unscanned`. This is not a
 *   pass and nothing renders it as one; it is the truthful statement that
 *   nobody looked. It is the default because a scanner nobody can enable is
 *   worse than an honest gap.
 *
 *   A PROVIDER CONFIGURED THAT CANNOT ANSWER — down, timing out, refusing the
 *   credentials, or returning something that is not a verdict. This is
 *   `error`, and under the default `CONTENT_SCAN_FAIL_MODE=closed` the
 *   attachment is DROPPED. An operator who turned scanning on asked for images
 *   to be checked, and silently publishing unchecked ones the moment the
 *   checker breaks is the single failure this file exists to prevent — it is
 *   also the state that lasts longest and is noticed least.
 *
 * `CONTENT_SCAN_FAIL_MODE=open` exists and is a deliberate choice an operator
 * can make out loud. It is not the default and the docs say what it gives up.
 */

/** Provider verdicts, and the two states that are not verdicts at all. */
export type ScanStatus =
  | "unscanned"
  | "skipped"
  | "pass"
  | "flagged"
  | "rejected"
  | "error";

export interface ScanResult {
  status: ScanStatus;
  /** Which scanner said so. Null only for `unscanned`. */
  provider: string | null;
  /** Highest category score, 0..1, normalised by the adapter. */
  score: number | null;
  /** Categories at or over threshold. Empty on a clean pass. */
  labels: string[];
  /**
   * The provider named material whose mere retention is a legal question, not
   * a policy one. Nothing auto-deletes an object marked this way — see
   * `sweepQuarantinedAttachments`.
   */
  illegal: boolean;
}

const UNSCANNED: ScanResult = {
  status: "unscanned",
  provider: null,
  score: null,
  labels: [],
  illegal: false,
};

/**
 * Only raster images are scannable, and only these five can be rendered inline
 * anyway (`isImageContentType`). Video, audio and PDF are recorded `skipped`
 * rather than `pass`: no classifier here looked at them, and saying otherwise
 * would be the same lie `unscanned` exists to avoid. That is a real gap and
 * `docs/CONTENT_SAFETY.md` says so in as many words.
 */
const SCANNABLE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function isScannableContentType(contentType: string): boolean {
  return SCANNABLE_TYPES.has(contentType);
}

/**
 * How long the presigned GET handed to a provider stays valid.
 *
 * Deliberately not the 12 hour read TTL. This URL goes to a third party and
 * lands in their request logs; two minutes is longer than any scan and short
 * enough that the log entry is a dead link by the time anyone reads it.
 */
export const SCAN_URL_TTL_SECONDS = 120;

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_REJECT_THRESHOLD = 0.9;
const DEFAULT_FLAG_THRESHOLD = 0.55;
const DEFAULT_QUARANTINE_DAYS = 30;

function envString(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envThreshold(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export type ContentScanProvider = "openai" | "webhook" | "sightengine";

/**
 * Read per call, never cached at import — the same rule `readConfig` in
 * `lib/s3.ts` follows, and for the same reason: a test that configures a
 * provider for one case must not have to win an import race to do it.
 */
export function contentScanProvider(): ContentScanProvider | null {
  const configured = envString("CONTENT_SCAN_PROVIDER")?.toLowerCase();
  if (configured === "openai") {
    return envString("OPENAI_API_KEY") ? "openai" : null;
  }
  if (configured === "webhook") {
    return envString("CONTENT_SCAN_URL") ? "webhook" : null;
  }
  if (configured === "sightengine") {
    return envString("SIGHTENGINE_API_USER") &&
      envString("SIGHTENGINE_API_SECRET")
      ? "sightengine"
      : null;
  }
  return null;
}

/**
 * False turns scanning off completely, the way a missing `S3_ENDPOINT` turns
 * attachments off. Note what it does NOT do: it does not make attachments fail.
 * An unconfigured scanner is a documented gap, not an outage.
 *
 * A provider named without its credentials reads as unconfigured rather than
 * broken, on purpose. The alternative — treating a half-set environment as
 * "configured, therefore fail closed" — bricks every image upload on a
 * deployment whose operator typed one variable and went to make tea.
 */
export function isContentScanConfigured(): boolean {
  return contentScanProvider() !== null;
}

/** `closed` drops what could not be scanned. The default, and the point. */
export function failsClosed(): boolean {
  return envString("CONTENT_SCAN_FAIL_MODE")?.toLowerCase() !== "open";
}

export function contentScanTimeoutMs(): number {
  return envNumber("CONTENT_SCAN_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

export function quarantineDays(): number {
  return envNumber("CONTENT_SCAN_QUARANTINE_DAYS", DEFAULT_QUARANTINE_DAYS);
}

function rejectThreshold(): number {
  return envThreshold("CONTENT_SCAN_REJECT_THRESHOLD", DEFAULT_REJECT_THRESHOLD);
}

function flagThreshold(): number {
  return envThreshold("CONTENT_SCAN_FLAG_THRESHOLD", DEFAULT_FLAG_THRESHOLD);
}

/**
 * Whether a face the classifier reads as under-18 is on its own worth a human
 * look. Default on.
 *
 * This WILL false-positive on young-looking adults, and that is the trade being
 * made knowingly: the outcome is a report in a queue, not a block, and on a
 * service whose terms say there is no version of it for minors, "a person who
 * may be a child is in this picture" is the single most useful thing an
 * automated system can put in front of a human.
 */
function flagMinors(): boolean {
  return envString("CONTENT_SCAN_FLAG_MINORS")?.toLowerCase() !== "false";
}

// --------------------------------------------------------------- the verdict

/**
 * Category scores, normalised across providers.
 *
 * Keys are this file's vocabulary, not any provider's. An adapter's whole job
 * is to land its response in this shape or fail; the policy below then reads
 * one set of names and never a provider's.
 */
interface CategoryScores {
  /** Sexual content involving an apparent minor. The one hard block. */
  csam_suspected?: number;
  /** An apparent minor is present, sexual context or not. */
  minor_present?: number;
  /** Graphic violence or injury. */
  gore?: number;
  /** Explicit adult sexual activity. Allowed here — see the policy note. */
  sexual_activity?: number;
  /** The provider's own "this is known illegal material" signal. */
  illegal?: number;
}

/**
 * Scores to a verdict.
 *
 * WHAT THIS PLATFORM ACTUALLY PROHIBITS is the input to every line here, and it
 * is not what a stock moderation config assumes. `client/src/pages/terms-page.tsx`
 * bans sexualising minors, CSAM, and intimate images shared without consent. It
 * does NOT ban adult nudity, and pqp.gg is 18+ by construction. So a nudity
 * classifier wired to block nudity would be enforcing a rule this service does
 * not have, and would generate a queue of reports no moderator can action.
 *
 * Consequently `sexual_activity` alone is never a rejection and never a flag.
 * It is carried only because it is half of the conjunction that matters:
 * apparent minor AND sexual content, which is `csam_suspected`, which is the
 * one label that blocks.
 *
 * Consent cannot be classified from pixels, so non-consensual intimate imagery
 * — the other thing the terms ban — is not detectable here at all and stays a
 * human-report problem. `docs/CONTENT_SAFETY.md` states that plainly.
 */
function decide(scores: CategoryScores, provider: string): ScanResult {
  const reject = rejectThreshold();
  const flag = flagThreshold();
  const labels: string[] = [];
  let status: ScanStatus = "pass";
  let illegal = false;
  let score = 0;

  /**
   * @param blockAt   score at or above which the attachment is refused, or
   *                  null for a category that can only ever be advisory.
   * @param legallyLoaded  a hit here means the object must never be auto-deleted.
   */
  const consider = (
    label: string,
    value: number | undefined,
    blockAt: number | null,
    legallyLoaded = false,
  ): void => {
    if (value === undefined || value < flag) {
      return;
    }
    score = Math.max(score, value);
    labels.push(label);
    // Legally loaded at the *flag* threshold, not the block one: a score
    // between the two is exactly the case where a human must look, and exactly
    // the case where auto-deleting the evidence first would be worst.
    illegal ||= legallyLoaded;
    if (blockAt !== null && value >= blockAt) {
      status = "rejected";
    } else if (status !== "rejected") {
      status = "flagged";
    }
  };

  // Known-illegal blocks at the FLAG threshold, not the reject one. A hash
  // match is not a probability the way a classifier score is, and treating it
  // as one would let a provider reporting 0.8 for a confirmed match publish it.
  consider("illegal", scores.illegal, flag, true);
  consider("csam_suspected", scores.csam_suspected, reject, true);
  if (flagMinors()) {
    consider("minor_present", scores.minor_present, null);
  }
  consider("gore", scores.gore, null);

  return {
    status,
    provider,
    score: Number(score.toFixed(4)),
    labels: [...new Set(labels)],
    illegal,
  };
}

function errorResult(provider: string, reason: string): ScanResult {
  return {
    status: "error",
    provider,
    score: null,
    labels: [`scan_error:${reason}`],
    illegal: false,
  };
}

// -------------------------------------------------------------- the adapters

/** A finite number in 0..1, or undefined. Anything else is not a score. */
function probability(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fetch a provider, with the timeout that makes "slow" and "down" the same
 * event. Returns the parsed JSON body, or an `error` verdict.
 *
 * Every failure funnels here rather than being handled per adapter: a DNS
 * failure, a 500, a 200 carrying HTML from a captive portal and a body that is
 * not JSON are all "the scanner did not answer", and the caller must not be
 * able to tell them apart well enough to accidentally treat one as a pass.
 */
async function fetchJson(
  provider: string,
  url: string,
  init: RequestInit,
): Promise<{ body: unknown } | { failure: ScanResult }> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(contentScanTimeoutMs()),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "unreachable";
    console.error(`[content-scan] ${provider} ${reason}:`, error);
    return { failure: errorResult(provider, reason) };
  }

  if (!response.ok) {
    console.error(`[content-scan] ${provider} returned HTTP ${response.status}`);
    return { failure: errorResult(provider, `http_${response.status}`) };
  }

  try {
    return { body: (await response.json()) as unknown };
  } catch (error) {
    console.error(`[content-scan] ${provider} returned non-JSON:`, error);
    return { failure: errorResult(provider, "malformed") };
  }
}

/**
 * OpenAI's moderation endpoint, and the recommended starting point for this
 * deployment, for three reasons that are hard to beat:
 *
 *   - IT IS FREE. `omni-moderation-latest` is not billed and does not count
 *     against usage limits, at any volume this service will reach.
 *   - IT TAKES A URL. `image_url` means OpenAI fetches the object from the
 *     bucket itself, which is the only reason this fits an architecture whose
 *     first rule is that bytes never enter the API process.
 *   - IT IS A MODERATION CLASSIFIER, not a general vision model prompted into
 *     being one, so its categories are already the question being asked and its
 *     scores are already calibrated to be thresholded.
 *
 * ONE LIMIT MATTERS MORE THAN ALL OF THAT, and it is why this cannot be the
 * whole answer: `sexual/minors` is a TEXT-ONLY category. Image input scores it
 * zero regardless of content. So this provider gives real coverage of graphic
 * violence and adult sexual content — of which only the former is against the
 * rules here — and no coverage whatsoever of the thing that actually matters.
 * The adapter reads the field anyway, because reading it costs nothing and the
 * day it becomes multimodal this starts working. CSAM remains a hash-matching
 * problem with a separate integration; `docs/CONTENT_SAFETY.md` is blunt about
 * that being the residual risk.
 */
async function scanViaOpenAi(imageUrl: string): Promise<ScanResult> {
  const provider = "openai";

  const result = await fetchJson(
    provider,
    "https://api.openai.com/v1/moderations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${envString("OPENAI_API_KEY")!}`,
      },
      body: JSON.stringify({
        model: envString("OPENAI_MODERATION_MODEL") ?? "omni-moderation-latest",
        input: [{ type: "image_url", image_url: { url: imageUrl } }],
      }),
    },
  );
  if ("failure" in result) {
    return result.failure;
  }

  const body = result.body;
  const results = isRecord(body) ? body.results : undefined;
  const first = Array.isArray(results) ? results[0] : undefined;
  const raw = isRecord(first) && isRecord(first.category_scores)
    ? first.category_scores
    : null;
  // A 200 with no scores is not a clean image. It is a response shape this code
  // does not understand — a changed schema, an error body served as 200, a
  // proxy in the way — and calling it a pass is exactly the silent failure this
  // whole file is built to refuse.
  if (!raw) {
    console.error(`[content-scan] openai returned no category_scores`);
    return errorResult(provider, "malformed");
  }

  const scores: CategoryScores = {};
  const minors = probability(raw["sexual/minors"]);
  if (minors !== undefined) {
    // Taken straight rather than multiplied against `sexual`: unlike the
    // Sightengine path, this is already a joint judgement about sexual content
    // involving a minor, so conjoining it a second time would halve it.
    scores.csam_suspected = minors;
  }
  const sexual = probability(raw.sexual);
  if (sexual !== undefined) {
    scores.sexual_activity = sexual;
  }
  const graphic = probability(raw["violence/graphic"]);
  if (graphic !== undefined) {
    scores.gore = graphic;
  }

  if (Object.keys(scores).length === 0) {
    console.error(`[content-scan] openai returned no known categories`);
    return errorResult(provider, "malformed");
  }
  return decide(scores, provider);
}

/**
 * The provider-agnostic one, and the extension point everything this codebase
 * cannot ship goes through: an HTTP endpoint the operator controls, handed a
 * presigned URL, answering a verdict.
 *
 * It exists for two things this file deliberately does not implement itself:
 *
 *   - CSAM HASH MATCHING. The IWF's Image Intercept and Project Arachnid's
 *     Shield both hand out free API access to small operators, and both require
 *     an application and a signed agreement first. Neither's credentials can be
 *     committed here, and neither's request shape can be honestly written
 *     against docs that are only visible after approval. So the plumbing lands
 *     here and the adapter is a small Worker the operator writes once they are
 *     approved — a hash match sets `"illegal": true` and everything downstream
 *     (block, quarantine, no auto-delete, loud log, report) already works.
 *   - ANYTHING RUN INSIDE CLOUDFLARE. A Worker bound to the R2 bucket can read
 *     the object with no egress and no presigned URL at all, and run Workers AI
 *     on the free daily allowance. That is the cheapest place inference can
 *     possibly happen for this deployment, and the bytes never leave
 *     Cloudflare's network.
 *
 * It equally fits a self-hosted classifier, a Lambda, or a shell script behind
 * a reverse proxy. `docs/CONTENT_SAFETY.md` carries a worked Worker.
 *
 * Response contract, and it is strict on purpose:
 *
 *   { "verdict": "pass" | "flag" | "reject",
 *     "score": 0.0-1.0,          // optional
 *     "labels": ["gore", ...],   // optional
 *     "illegal": false }         // optional
 *
 * Anything else — a missing verdict, a verdict that is not one of the three, a
 * JSON array, a 200 with an empty body — is `error`, which under the default
 * fail mode drops the attachment. A scanner that has been half-deployed must
 * not read as a pass.
 */
async function scanViaWebhook(
  imageUrl: string,
  contentType: string,
): Promise<ScanResult> {
  const provider = "webhook";
  const endpoint = envString("CONTENT_SCAN_URL")!;
  const token = envString("CONTENT_SCAN_TOKEN");

  const result = await fetchJson(provider, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ imageUrl, contentType }),
  });
  if ("failure" in result) {
    return result.failure;
  }

  const body = result.body;
  if (!isRecord(body)) {
    return errorResult(provider, "malformed");
  }

  const verdict = body.verdict;
  if (verdict !== "pass" && verdict !== "flag" && verdict !== "reject") {
    console.error(`[content-scan] webhook returned no usable verdict`);
    return errorResult(provider, "malformed");
  }

  const labels = Array.isArray(body.labels)
    ? body.labels.filter((label): label is string => typeof label === "string")
    : [];

  return {
    status:
      verdict === "reject" ? "rejected" : verdict === "flag" ? "flagged" : "pass",
    provider: typeof body.provider === "string" ? body.provider : provider,
    score: probability(body.score) ?? null,
    labels,
    // Trusted from the endpoint because the endpoint is the operator's own, and
    // it is the only component in the chain that could ever know.
    illegal: body.illegal === true,
  };
}

/**
 * Sightengine, because it is the one commercial classifier with a self-serve
 * free tier, no sales call, and a `url=` parameter — it fetches the object from
 * the bucket itself, which is what keeps the bytes off this process.
 *
 * Models are configurable because the useful set here is not the default one:
 * this service permits adult nudity, so the models worth paying for are the
 * ones that speak to minors and gore.
 */
async function scanViaSightengine(imageUrl: string): Promise<ScanResult> {
  const provider = "sightengine";
  const models = envString("SIGHTENGINE_MODELS") ?? "nudity-2.1,gore,face-attributes";

  const endpoint = new URL("https://api.sightengine.com/1.0/check.json");
  endpoint.searchParams.set("url", imageUrl);
  endpoint.searchParams.set("models", models);
  endpoint.searchParams.set("api_user", envString("SIGHTENGINE_API_USER")!);
  endpoint.searchParams.set("api_secret", envString("SIGHTENGINE_API_SECRET")!);

  const result = await fetchJson(provider, endpoint.toString(), {
    method: "GET",
  });
  if ("failure" in result) {
    return result.failure;
  }

  const body = result.body;
  if (!isRecord(body) || body.status !== "success") {
    console.error(`[content-scan] sightengine did not report success`);
    return errorResult(provider, "malformed");
  }

  const scores = normaliseSightengine(body);
  // A success with no category this code understands means the account is
  // configured for models nobody here reads, and scoring it 0 would be a pass
  // nobody performed.
  if (Object.keys(scores).length === 0) {
    console.error(`[content-scan] sightengine returned no known categories`);
    return errorResult(provider, "malformed");
  }
  return decide(scores, provider);
}

/**
 * Sightengine's response into this file's vocabulary.
 *
 * Split out and exported for the tests, because this mapping is where a
 * provider's schema change turns into a silent pass: a renamed field reads as
 * `undefined`, `undefined` never crosses a threshold, and the image sails
 * through. The empty-result guard above is what turns "I understood nothing"
 * into an error rather than a pass; these tests are what keep it honest for
 * "I understood one field out of four".
 */
export function normaliseSightengine(
  body: Record<string, unknown>,
): CategoryScores {
  const scores: CategoryScores = {};

  const nudity = isRecord(body.nudity) ? body.nudity : null;
  let sexual: number | undefined;
  if (nudity) {
    // 2.1 reports a distribution over classes. The explicit ones are what an
    // "is this sexual" question means; `suggestive` and below are not.
    const explicit = [
      probability(nudity.sexual_activity),
      probability(nudity.sexual_display),
      probability(nudity.erotica),
    ].filter((value): value is number => value !== undefined);
    if (explicit.length > 0) {
      sexual = Math.max(...explicit);
      scores.sexual_activity = sexual;
    }
  }

  // `face-attributes` reports a per-face minor probability; the collection
  // shape differs by model version, so both the flat and the per-face forms are
  // read rather than assuming one.
  const minor = readMinorProbability(body);
  if (minor !== undefined) {
    scores.minor_present = minor;
    if (sexual !== undefined) {
      // The conjunction, and the only thing here that blocks. Multiplying two
      // independent-ish probabilities is deliberately conservative: it takes
      // real confidence in BOTH to reach the reject threshold, which is the
      // correct bar for an automated block that a human may never revisit.
      scores.csam_suspected = minor * sexual;
    }
  }

  const gore = isRecord(body.gore) ? probability(body.gore.prob) : undefined;
  if (gore !== undefined) {
    scores.gore = gore;
  }

  return scores;
}

function readMinorProbability(
  body: Record<string, unknown>,
): number | undefined {
  const direct = isRecord(body.minor) ? probability(body.minor.prob) : undefined;
  if (direct !== undefined) {
    return direct;
  }

  const faces = body.faces;
  if (!Array.isArray(faces)) {
    return undefined;
  }
  const perFace = faces
    .map((face) => {
      if (!isRecord(face)) {
        return undefined;
      }
      const attributes = isRecord(face.attributes) ? face.attributes : face;
      return probability(attributes.minor);
    })
    .filter((value): value is number => value !== undefined);
  return perFace.length > 0 ? Math.max(...perFace) : undefined;
}

// ------------------------------------------------------------------ entry point

export interface ScanImageInput {
  /** Short-lived presigned GET. The provider fetches this; we never do. */
  imageUrl: string;
  contentType: string;
}

/**
 * Scan one image, or say honestly why it was not scanned.
 *
 * Never throws. A scanner that can take the send path down with it is worse
 * than no scanner, so every failure is a recorded `error` verdict and the
 * decision about what an `error` means belongs to the caller and to
 * `CONTENT_SCAN_FAIL_MODE` — not to a stack trace.
 */
export async function scanImage(input: ScanImageInput): Promise<ScanResult> {
  const provider = contentScanProvider();
  if (!provider) {
    return UNSCANNED;
  }
  if (!isScannableContentType(input.contentType)) {
    return { ...UNSCANNED, status: "skipped", provider };
  }

  try {
    switch (provider) {
      case "openai":
        return await scanViaOpenAi(input.imageUrl);
      case "webhook":
        return await scanViaWebhook(input.imageUrl, input.contentType);
      case "sightengine":
        return await scanViaSightengine(input.imageUrl);
    }
  } catch (error) {
    // The adapters funnel their own failures through `fetchJson`; this catches
    // the ones they cannot anticipate — a URL that will not construct, a
    // provider library throwing on a shape nobody predicted. Same answer.
    console.error(`[content-scan] ${provider} threw:`, error);
    return errorResult(provider, "unexpected");
  }
}

/**
 * Whether a verdict lets the attachment onto a message.
 *
 * The whole fail-closed rule, in one place, so no caller re-derives it:
 *
 *   pass / flagged / unscanned / skipped  →  attach
 *   rejected                              →  never
 *   error                                 →  only if the operator opted out
 *
 * `flagged` attaches on purpose. A flag is "a human should look at this", not
 * "this is prohibited" — this service permits adult content, its flag
 * categories are advisory, and blocking on them would build a queue of
 * false positives that trains the operator to clear it without reading. The
 * report is the product of a flag; the block is the product of a rejection.
 */
export function scanAllowsAttachment(result: ScanResult): boolean {
  if (result.status === "rejected") {
    return false;
  }
  if (result.status === "error") {
    return !failsClosed();
  }
  return true;
}
