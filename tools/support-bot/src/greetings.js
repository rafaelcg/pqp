/**
 * Answering a newcomer's hello.
 *
 * ── WHAT THIS IS, AND WHAT IT IS CAREFULLY NOT ──────────────────────────────
 *
 * Somebody joins the QG, opens the channel where people talk, types "oi", and
 * nothing happens. That silence is the moment a new person decides the room is
 * dead. This file gives them one reply, from a line a human wrote, so the
 * channel has a pulse and the person feels seen.
 *
 * It is NOT the bot announcing arrivals. The README's third property, "it never
 * speaks unprompted", survives because the trigger is still a message somebody
 * sent: the person said hello into the room, and a hello is the one message a
 * room is expected to answer. Two conditions have to hold at once, and both
 * are checked here, deterministically:
 *
 *   1. the author joined the server LESS THAN FIFTEEN MINUTES AGO, and
 *   2. the message READS AS A GREETING, by word list, not by model.
 *
 * Somebody who joined an hour ago and says "oi" gets nothing. Somebody who
 * joined three minutes ago and asks a question gets nothing from here (the
 * ordinary support path still applies to them, unchanged). The reply is one
 * line from `greetings-pool.js`, posted as a reply to their message, once per
 * person for the life of the ledger.
 *
 * ── HOW IT KNOWS SOMEBODY IS NEW ────────────────────────────────────────────
 *
 * It does not, exactly, and the approximation is written down here because it
 * is the one place this feature can be wrong in an embarrassing direction.
 *
 * The server keeps `server_members.joined_at` but, as of this writing, neither
 * exposes it on `GET /api/servers/:id/members` nor sends any frame over `/ws`
 * when a membership is created (`redeemInvite` only invalidates an audience
 * cache). Changing that restarts `pqp-api` and is a separate decision, so the
 * bot works from what it can observe: the member roster, fetched at boot and on
 * a timer, and diffed against the roster it persisted. An id that appears
 * between two fetches is new, and the fetch that revealed it is the best
 * available estimate of when they joined.
 *
 * That estimate is only trusted when the two fetches are close together. After
 * a restart or a long outage the roster may be hours stale, and a person who
 * joined during the gap would look brand new at boot. So a gap longer than the
 * newcomer window makes everyone who appeared in it NOT new, deliberately. A
 * missed hello costs nothing; greeting somebody as a newcomer three hours after
 * they arrived reads as a bot that does not know what is going on, which is
 * exactly the impression this account must never give. Fail quiet.
 *
 * If the members endpoint ever grows a `joinedAt` field, `Roster.observe`
 * prefers it over the estimate with no other change. The first roster ever
 * seen (no ledger on disk) seeds everybody as not-new, so switching the feature
 * on never greets the existing membership.
 *
 * Everything here is pure given a clock and a random source; `bot.js` owns the
 * network, the timer and the socket.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { HELLO_REPLIES } from "./greetings-pool.js";

/** How recently somebody must have joined to count as a newcomer. */
export const NEWCOMER_WINDOW_MS = 15 * 60_000;
/** The flood cap's window: at most `maxPerWindow` replies inside it. */
export const CAP_WINDOW_MS = 10 * 60_000;
/** Default flood cap. Three hellos in ten minutes is a busy night for the QG. */
export const DEFAULT_MAX_PER_WINDOW = 3;

/** Reasons, as constants, so the log and the tests cannot disagree. */
export const HELLO_SKIP = {
  DISABLED: "greetings-disabled",
  CHANNEL: "channel-not-greeting-channel",
  SELF: "self",
  WEBHOOK: "webhook",
  BOT_AUTHOR: "bot-author",
  CHARACTER: "character",
  ALREADY: "already-greeted",
  NOT_NEW: "not-new",
  NOT_GREETING: "not-a-greeting",
  CAP: "greeting-cap",
};

/**
 * `SUPPORT_BOT_GREETINGS=false` turns this feature off and nothing else.
 *
 * Default on. The general kill switches (`SUPPORT_BOT_KILL_SWITCH`,
 * `AMBIENT_KILL_SWITCH`) are checked by `bot.js` before any post and stop this
 * too; this one exists so "the hellos are annoying" does not have to mean
 * "take support down".
 */
export function greetingsEnabled(env = process.env) {
  const value = String(env.SUPPORT_BOT_GREETINGS ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * Strip the message down to letters and spaces so the word list can be short.
 *
 * Lowercased, accents removed ("olá" and "ola" are the same hello), emoji and
 * punctuation turned into spaces, whitespace collapsed. Repeated letters are
 * kept and handled by the patterns, because "oiii" is a hello and "hello" has a
 * double letter that must survive.
 */
function normalise(body) {
  return String(body ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9@\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hellos that count on their own, whatever follows them.
 *
 * "oi como faço pra entrar na call" is a greeting AND a question, and the
 * person deserves the hello back. Letter runs (`o+i+`) cover "oii", "olaaa",
 * "salveee".
 */
const STRONG =
  "o+i+e*|o+l+a+r?|e+a+e+w*|e+a+i+|e a+i+|s+a+l+v+e+|bo+m+ di+a+|bo+a+ ta+r+de+|bo+a+ noi+te+|che+gue+i+|he+l+o+|hi+|he+y+";

/**
 * Hellos that are also ordinary words, so they only count when they are the
 * whole message or are followed by a vocative. "opa, deu erro aqui" is not a
 * greeting; "opa!" and "fala galera" are.
 */
const WEAK = "o+pa+|fa+la+|che+ga+ndo+|bo+a+";

const VOCATIVE =
  "gente|pessoal|galera|povo|turma|todos|todas|amigos|amigas|meu povo|gente boa|ai|aew|@[a-z0-9_]+";

const STRONG_RE = new RegExp(`^(?:${STRONG})(?:\\s|$)`);
const WEAK_RE = new RegExp(`^(?:${WEAK})(?:\\s+(?:${VOCATIVE}))*$`);

/**
 * Does this message read as somebody saying hello?
 *
 * A word list and two regular expressions. Not a model, on purpose: a greeting
 * detector that a human can read top to bottom and predict is worth more here
 * than one that also catches "yo". Every hit and miss the QG actually produces
 * is in `test/greetings.test.js`; add the ones it gets wrong there first.
 */
export function isGreeting(body) {
  const text = normalise(body);
  if (!text) {
    return false;
  }
  // A greeting is short. Past this it is a paragraph that happens to start
  // with "oi", and the bot answering "chegou!" under a paragraph reads wrong.
  if (text.length > 200) {
    return false;
  }
  return STRONG_RE.test(text) || WEAK_RE.test(text);
}

/**
 * Pick a line, never the one just used.
 *
 * Two people saying hello a minute apart must not get the same joke, because
 * the second one can see the first. With one line in the pool there is no
 * choice to make and it repeats.
 */
export function pickLine(pool, lastIndex, random = Math.random) {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new Error("pickLine: empty pool");
  }
  if (pool.length === 1) {
    return 0;
  }
  const candidates = pool.map((_, i) => i).filter((i) => i !== lastIndex);
  return candidates[Math.floor(random() * candidates.length)];
}

/** Fill the `{name}` slot. `@username` when there is one, the display name otherwise. */
export function renderLine(line, { username, displayName }) {
  const name = username ? `@${username}` : String(displayName ?? "").trim() || "você";
  return line.replaceAll("{name}", name);
}

/** What a ledger looks like before it has seen anything. */
function emptyLedger() {
  return { version: 1, lastPollAt: 0, members: {}, greeted: {} };
}

/**
 * Who is in the server, when the bot first saw them, and who it has greeted.
 *
 * On disk, like `Budget`, and for the same reason: a "once per person" that
 * forgets on restart is a bot that greets the same person twice on the night
 * the machine is flapping. `path: null` keeps it in memory for tests and dry
 * runs.
 */
export class Roster {
  /**
   * @param {object} options
   * @param {string|null} options.path
   * @param {number} [options.windowMs]  how long somebody counts as new
   */
  constructor({ path = null, windowMs = NEWCOMER_WINDOW_MS } = {}) {
    this.path = path;
    this.windowMs = windowMs;
    this.state = this.#read();
  }

  #read() {
    if (!this.path) {
      return emptyLedger();
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.members) {
        return emptyLedger();
      }
      return { ...emptyLedger(), ...parsed };
    } catch {
      // A missing or corrupt ledger starts over. Starting over means the next
      // `observe` is a first roster, which seeds everybody as not-new, so the
      // worst case of losing the file is a few missed hellos, never a repeat.
      return emptyLedger();
    }
  }

  #write() {
    if (!this.path) {
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state)}\n`);
  }

  /**
   * Fold a fresh roster in. Returns the ids that appeared since the last one.
   *
   * @param {Array<{id:string, username?:string|null, displayName?:string, isCharacter?:boolean, joinedAt?:string|null}>} members
   * @param {number} now
   */
  observe(members, now) {
    const first = this.state.lastPollAt === 0;
    // See the file header: an estimate from a stale roster is worse than none.
    const gapTrusted = !first && now - this.state.lastPollAt <= this.windowMs;
    const appeared = [];
    for (const member of members) {
      const known = this.state.members[member.id];
      const joinedAt = member.joinedAt ? Date.parse(member.joinedAt) : NaN;
      let firstSeenAt = known?.firstSeenAt ?? null;
      if (!known) {
        if (Number.isFinite(joinedAt)) {
          firstSeenAt = joinedAt;
        } else if (!first && gapTrusted) {
          firstSeenAt = now;
        }
        if (!first) {
          appeared.push(member.id);
        }
      } else if (Number.isFinite(joinedAt) && known.firstSeenAt === null) {
        // The endpoint started answering with the real thing; take it.
        firstSeenAt = joinedAt;
      }
      this.state.members[member.id] = {
        firstSeenAt,
        username: member.username ?? null,
        displayName: member.displayName ?? known?.displayName ?? null,
        isCharacter: Boolean(member.isCharacter ?? known?.isCharacter),
      };
    }
    this.state.lastPollAt = now;
    this.#write();
    return appeared;
  }

  member(id) {
    return this.state.members[id];
  }

  /** Joined inside the window, as far as this bot can tell. Unknown is not new. */
  isNew(id, now) {
    const seenAt = this.state.members[id]?.firstSeenAt;
    return Number.isFinite(seenAt) && seenAt !== null && now - seenAt < this.windowMs;
  }

  wasGreeted(id) {
    return Boolean(this.state.greeted[id]);
  }

  markGreeted(id, now, how = "replied") {
    this.state.greeted[id] = { at: new Date(now).toISOString(), how };
    this.#write();
  }
}

/**
 * The decision: does this message get a hello back, and which one?
 *
 * Mirrors `screenTrigger` in shape: pure, every "no" carries a reason, and the
 * self check runs first because a bot answering its own hello is the one
 * outcome no rate cap fixes.
 */
export class Greeter {
  /**
   * @param {object} options
   * @param {Roster} options.roster
   * @param {import("../../ambient/src/schedule.js").RateCap} options.rateCap
   * @param {string} options.channelId       the one channel hellos are answered in
   * @param {string|null} options.botUserId
   * @param {boolean} [options.enabled]
   * @param {number} [options.maxPerWindow]
   * @param {string[]} [options.pool]
   * @param {() => number} [options.random]
   */
  constructor({
    roster,
    rateCap,
    channelId,
    botUserId,
    enabled = true,
    maxPerWindow = DEFAULT_MAX_PER_WINDOW,
    capWindowMs = CAP_WINDOW_MS,
    pool = HELLO_REPLIES,
    random = Math.random,
  }) {
    this.roster = roster;
    this.rateCap = rateCap;
    this.channelId = channelId;
    this.botUserId = botUserId;
    this.enabled = enabled;
    this.maxPerWindow = maxPerWindow;
    this.capWindowMs = capWindowMs;
    this.pool = pool;
    this.random = random;
    this.lastIndex = -1;
  }

  /**
   * Returns `{ post, replyToId }` or `{ post: null, reason }`.
   *
   * A newcomer refused by the cap is still MARKED GREETED. The alternative is a
   * hello that arrives ten minutes late, under a conversation that has moved
   * on, which is worse than none.
   */
  decide(message, now = Date.now()) {
    if (!this.enabled) {
      return { post: null, reason: HELLO_SKIP.DISABLED };
    }
    if (message.authorId === this.botUserId) {
      return { post: null, reason: HELLO_SKIP.SELF };
    }
    if (message.channelId !== this.channelId) {
      return { post: null, reason: HELLO_SKIP.CHANNEL };
    }
    if (message.isWebhook) {
      return { post: null, reason: HELLO_SKIP.WEBHOOK };
    }
    if (/\[bot\]\s*$/i.test(String(message.authorName ?? ""))) {
      return { post: null, reason: HELLO_SKIP.BOT_AUTHOR };
    }
    const member = this.roster.member(message.authorId);
    if (member?.isCharacter) {
      return { post: null, reason: HELLO_SKIP.CHARACTER };
    }
    if (this.roster.wasGreeted(message.authorId)) {
      return { post: null, reason: HELLO_SKIP.ALREADY };
    }
    if (!this.roster.isNew(message.authorId, now)) {
      return { post: null, reason: HELLO_SKIP.NOT_NEW };
    }
    if (!isGreeting(message.body)) {
      return { post: null, reason: HELLO_SKIP.NOT_GREETING };
    }
    if (!this.rateCap.allow("greeting", this.maxPerWindow, now, this.capWindowMs)) {
      this.roster.markGreeted(message.authorId, now, "capped");
      return { post: null, reason: HELLO_SKIP.CAP };
    }

    const index = pickLine(this.pool, this.lastIndex, this.random);
    this.lastIndex = index;
    const post = renderLine(this.pool[index], {
      username: member?.username ?? null,
      displayName: member?.displayName ?? message.authorName,
    });
    return { post, replyToId: message.id, reason: "hello" };
  }

  /** Call after the reply actually went out. */
  recordSent(message, now = Date.now()) {
    this.rateCap.record("greeting", now);
    this.roster.markGreeted(message.authorId, now, "replied");
  }
}
