/**
 * Answering a question nobody answered.
 *
 * ── WHAT CHANGED, AND WHAT DID NOT ──────────────────────────────────────────
 *
 * Until this file existed, the bot spoke only when somebody typed its name (or
 * replied to it), plus the one hello a newcomer gets. `trigger.js` still argues
 * that case and every word of it is still true for the room's NORMAL traffic:
 * two humans helping each other in #ajuda is the best outcome, question
 * detection misfires constantly, and a mention is consent.
 *
 * What that argument does not cover is the case the owner actually hit:
 * somebody asks about call quality in #geral, and NOBODY ANSWERS AT ALL. There
 * is no conversation to interrupt, no human whose answer is being pre-empted,
 * and no ambiguity about whether the room was going to handle it. The room had
 * three minutes and did nothing. That is the only situation this file speaks
 * in, and every rule below exists to make sure it is the only one.
 *
 * So the trigger argument is not reversed, it is fenced. The bot still does not
 * answer questions in a live room. It answers a question the room dropped.
 *
 * ── THE SEVEN CONDITIONS ────────────────────────────────────────────────────
 *
 * All of them, together, or silence:
 *
 *   1. THE CHANNEL IS WATCHED. `SUPPORT_CHANNELS`, same list the mention path
 *      uses. Nothing new becomes reachable.
 *   2. IT READS AS A QUESTION PUT TO THE ROOM. `looksLikeRoomQuestion` below:
 *      a question mark, three words or more, no `@` at anybody, not a reply to
 *      a specific message, not a greeting, and not on the room-chatter list.
 *   3. NOBODY ELSE SPOKE AFTER IT. Any message from a different human in that
 *      channel cancels it outright. This is the load-bearing one, see below.
 *   4. THE DELAY ELAPSED. `SUPPORT_UNPROMPTED_DELAY_MS`, about three minutes.
 *   5. IT IS NOT STALE. Past `SUPPORT_UNPROMPTED_MAX_AGE_MS` the question is
 *      dropped instead of answered, so a stalled or restarted process never
 *      turns up under an hour-old message.
 *   6. THE BOT DID NOT JUST SPEAK IN THAT CHANNEL. Never two of its messages in
 *      a row without a person in between.
 *   7. THE CAPS AND THE BUDGET ALLOW IT. `screenUnprompted`.
 *
 * And one more that lives in `bot.js` because it needs the model: the answer
 * has to come back confidently grounded in `facts.md` (`CERTO:`), or the bot
 * says nothing at all. NOT the "essa eu não sei responder" fallback: that
 * sentence is correct when somebody asked the bot directly and deserves an
 * answer, and it is pure noise when nobody was talking to it.
 *
 * ── WHY "ANYBODY ELSE SPOKE" CANCELS, AND NOT "SOMEBODY REPLIED" ────────────
 *
 * The brief was "a message that already got any human reply is out", and in
 * chat there is no reliable way to tell a reply from an adjacent message. The
 * `replyTo` field is used by a minority of people; most answers are just the
 * next message.
 *
 * So the rule is deliberately blunter than the brief and strictly safer: ANY
 * message from a different human in the channel, after the question, cancels
 * it. That has a consequence worth stating plainly, because it is the single
 * biggest thing shaping how often this fires: in a busy room this feature is
 * effectively off. Somebody always says something within three minutes, and
 * every one of those cancels. What survives is a question posted into a quiet
 * channel that stays quiet, which is exactly, and only, the case this was
 * built for.
 *
 * It also disposes of "chatter between two people" without needing to detect
 * it. If A and B are talking and A asks something, B answers within three
 * minutes and it cancels. If B does not, then the conversation is over and A's
 * question is a question nobody answered, which is the case above.
 *
 * The asker's OWN follow-up is the exception: it does not cancel, because
 * somebody bumping their own unanswered question ("alguém?") has not been
 * answered by anybody. It does not restart the clock either, so a bump cannot
 * be used to keep pushing the deadline back.
 *
 * ── ONE PENDING QUESTION PER CHANNEL ────────────────────────────────────────
 *
 * A consequence of the cancel rule rather than a separate policy: a second
 * person's question is itself a message from a different human, so it cancels
 * the first and takes the slot. The store holds one entry per channel and the
 * tests pin that, because it is what bounds both the memory and the number of
 * model calls this path can ever cost.
 *
 * ── RESTARTS ────────────────────────────────────────────────────────────────
 *
 * The store is IN MEMORY ONLY, on purpose, and that is the whole restart
 * story: a redeploy drops every pending question, and the bot comes back with
 * nothing to say about anything that was asked before it went down. A ledger on
 * disk would be strictly worse here, the mirror image of `Budget`, where
 * persistence is the point. Answering an hour-old question after a redeploy is
 * the exact "bot that does not know what is going on" failure the greeting
 * roster also refuses (see `greetings.js`), and it costs nothing to miss.
 *
 * `maxAgeMs` covers the same failure from the other direction: a process that
 * was alive but wedged (a long reconnect, a blocked event loop) wakes up with a
 * pending question that is now forty minutes old. Due, but stale, so dropped.
 *
 * Everything here is pure given a clock. `bot.js` owns the socket and the
 * model.
 */
import { isAutomatedAuthor } from "./trigger.js";
import { isGreeting, normaliseText } from "./greetings.js";

/**
 * How long the room gets to answer before the bot will.
 *
 * Three minutes. Long enough that a person who is typing an answer, or who
 * looks at the channel on their next glance, gets there first; short enough
 * that the asker is plausibly still in the room reading. A minute would race
 * the humans, and ten minutes answers into a room that has moved on.
 */
export const DEFAULT_DELAY_MS = 3 * 60_000;

/**
 * Past this, a due question is dropped instead of answered. Ten minutes: over
 * three times the delay, so ordinary loop latency never trips it, and short
 * enough that nothing the bot posts is ever a surprise from the past.
 */
export const DEFAULT_MAX_AGE_MS = 10 * 60_000;

/**
 * Unprompted answers per channel per hour.
 *
 * Two. The reasoning is about what the room reads like rather than about cost.
 * The case this exists for is one dropped question in a quiet stretch, and a
 * quiet stretch does not produce three of those an hour. Two is enough to catch
 * the real case twice over and low enough that no hour can ever look like the
 * bot talking to itself. It also sits well under the 12/hour general channel
 * cap, so this path can never crowd out the answers somebody actually asked
 * for.
 */
export const DEFAULT_MAX_PER_CHANNEL_HOUR = 2;

/**
 * Model calls this path may make per channel per hour, answered or not.
 *
 * Four, because the silent outcome costs the same as the spoken one and is by
 * design the common one. This bounds the cost of a channel full of questions
 * the fact file does not cover. The daily ledger is still the real ceiling
 * (4/hour across two channels would exceed `SUPPORT_MAX_CALLS_PER_DAY` if it
 * ran flat out all day, which is the backstop working as intended).
 */
export const DEFAULT_MAX_TRIES_PER_CHANNEL_HOUR = 4;

/**
 * Model calls this path refuses to be the last consumer of.
 *
 * Thirty. Without it, an unprompted path that fired all day could spend the
 * daily ceiling and leave somebody who typed `@manual_bot` a "daily-cap" skip.
 * The path nobody asked for must never starve the path somebody did.
 */
export const DEFAULT_BUDGET_RESERVE = 30;

/** Why a message is not a question put to the room. */
export const NOT_ROOM_QUESTION = {
  EMPTY: "empty",
  REPLY: "reply-to-someone",
  MENTION: "addressed-to-someone",
  NO_QUESTION_MARK: "no-question-mark",
  TOO_SHORT: "too-short",
  TOO_LONG: "too-long",
  GREETING: "greeting",
  CHATTER: "room-chatter",
};

/** Why a due question is not answered after all. */
export const UNPROMPTED_SKIP = {
  DISABLED: "unprompted-disabled",
  CHANNEL: "channel-not-allowed",
  COOLDOWN: "cooldown",
  USER_CAP: "user-cap",
  CHANNEL_CAP: "channel-cap",
  UNPROMPTED_CAP: "unprompted-cap",
  TRY_CAP: "unprompted-try-cap",
  BUDGET_RESERVE: "budget-reserve",
  DAILY_CAP: "daily-cap",
};

/** Shortest and longest thing that can be a question put to a room. */
const MIN_WORDS = 3;
const MAX_WORDS = 60;
const MAX_CHARS = 300;

/**
 * Questions that are questions and are not for this bot.
 *
 * Hand-written, readable top to bottom, and checked against the NORMALISED
 * message, the same way `isGreeting` is. Every one of these is something the
 * QG says several times a night, every one of them ends in a question mark, and
 * a model asked about any of them would answer NAO_SEI anyway. Catching them
 * here saves the call and, more importantly, keeps the failure deterministic:
 * if the bot ever does answer one of these, the line that let it through is in
 * this list and can be fixed without touching a prompt.
 *
 * Anchored patterns, not substrings. "alguém aí?" is chatter; "alguém aí pra me
 * ajudar com a call?" is a support question and must survive.
 */
const ROOM_CHATTER = [
  // Roll call. "alguém aí?", "tem alguém on?", "quem tá acordado?"
  /^(alguem|tem alguem|tem gente|quem|quem que)\s+(ta|tao|to)?\s*(ai|on|online|acordado|acordada|vivo|viva)$/,
  // "tá on?", "to on?", "tão ai?"
  /^(ta|tao|to|tamo|tamos)\s+(on|online|ai|ae)$/,
  // Organising something. "bora jogar?", "alguém quer call?", "quem vai?"
  /^bora\b/,
  /^(alguem|quem|alguem ai)\s+(quer|vai|topa|ta afim|ta a fim|bora|joga|entra)\b/,
  // "cadê todo mundo?", "kd vcs?"
  /^(cade|kd)\b/,
  // Reactions. "sério?", "jura?", "que isso?", "oq foi?"
  /^(serio|serio isso|verdade|jura|jurass|ata|eita|oq|o que|que|como assim|ne|neh)\b.{0,12}$/,
  // Talking to a person without an @. "vc viu?", "tu tá vendo isso?"
  /^(vc|voce|vcs|voces|tu|ce|ces)\s+(viu|viram|ta|tao|tas|ve|vendo|vem|vai|vao)\b/,
  // Asking about a person or a specific account, which is a human's job.
  /^(quem e|quem eh|quem sao)\b/,
];

/**
 * Does this message read as a question put to the room, rather than to a
 * person, about nothing in particular, or at the bot?
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`. Deterministic, no model,
 * and tuned hard towards `false`: every miss costs one unanswered question that
 * a human may still answer, and every false positive costs a bot barging into a
 * conversation, which is the failure the whole account is built to avoid.
 *
 * The question mark is required, and that is the single strictest rule here.
 * Plenty of real questions in the QG are typed without one, and they are all
 * given up deliberately: it is the one signal that is cheap, unambiguous and
 * impossible to argue with, and this path has to be wrong far less often than
 * it is right.
 */
export function looksLikeRoomQuestion(message) {
  const body = String(message?.body ?? "");

  // A reply is aimed at one message and, through it, at one person. Whatever
  // else it is, it is not a question the room was left holding.
  if (message?.replyTo) {
    return { ok: false, reason: NOT_ROOM_QUESTION.REPLY };
  }

  // Any @ at all. A mention of a person is a question addressed to them; a
  // mention of the bot is the ordinary path, which already ran and decided.
  // `@everyone` lands here too, and an announcement is not this either.
  if (/@[A-Za-z0-9_]{2,32}/.test(body)) {
    return { ok: false, reason: NOT_ROOM_QUESTION.MENTION };
  }

  if (!body.includes("?")) {
    return { ok: false, reason: NOT_ROOM_QUESTION.NO_QUESTION_MARK };
  }

  const text = normaliseText(body);
  if (!text) {
    return { ok: false, reason: NOT_ROOM_QUESTION.EMPTY };
  }
  if (text.length > MAX_CHARS) {
    return { ok: false, reason: NOT_ROOM_QUESTION.TOO_LONG };
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length < MIN_WORDS) {
    return { ok: false, reason: NOT_ROOM_QUESTION.TOO_SHORT };
  }
  if (words.length > MAX_WORDS) {
    return { ok: false, reason: NOT_ROOM_QUESTION.TOO_LONG };
  }

  // "oi, alguém sabe se dá pra 4k?" is a hello first. The hello path owns it,
  // and answering it twice is worse than answering it once.
  if (isGreeting(body)) {
    return { ok: false, reason: NOT_ROOM_QUESTION.GREETING };
  }

  for (const pattern of ROOM_CHATTER) {
    if (pattern.test(text)) {
      return { ok: false, reason: NOT_ROOM_QUESTION.CHATTER };
    }
  }

  return { ok: true };
}

/**
 * `SUPPORT_UNPROMPTED=false` turns this whole file off and nothing else.
 *
 * Default on, matching `SUPPORT_BOT_GREETINGS`. It is a plain environment
 * variable and not a build-time constant precisely so that "this is annoying,
 * stop it" is `fly secrets set SUPPORT_UNPROMPTED=false -a pqp-support` at any
 * hour, with no branch, no CI and no image build. The general kill switches
 * still stop this too, along with everything else.
 */
export function unpromptedEnabled(env = process.env) {
  const value = String(env.SUPPORT_UNPROMPTED ?? "").trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
}

/**
 * The one question per channel the room has not answered yet.
 *
 * Fed every inbound message from the watched channels, plus a note every time
 * the bot itself posts. In memory, deliberately: see the header.
 */
export class PendingQuestions {
  /**
   * @param {object} options
   * @param {string|null} options.botUserId
   * @param {Set<string>} [options.ignoreUserIds]
   * @param {number} [options.delayMs]
   * @param {number} [options.maxAgeMs]
   */
  constructor({
    botUserId = null,
    ignoreUserIds = new Set(),
    delayMs = DEFAULT_DELAY_MS,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    enabled = true,
  } = {}) {
    /**
     * Off means off, at the earliest point. `screenUnprompted` refuses a
     * disabled candidate too, but a store that keeps tracking questions nobody
     * will ever answer spends memory and, worse, writes an
     * `unprompted.tracked` line for every question in the room while the
     * feature is switched off. A switch that is still visibly doing something
     * is a switch people stop trusting.
     */
    this.enabled = enabled;
    this.botUserId = botUserId;
    this.ignoreUserIds = ignoreUserIds;
    this.delayMs = delayMs;
    this.maxAgeMs = maxAgeMs;
    /** channelId -> candidate. At most one, see the header. */
    this.pending = new Map();
    /** channelId -> true while the bot's own last message is the newest one. */
    this.awaitingHuman = new Map();
  }

  /**
   * When the question was asked, from the server's clock when it sent one.
   *
   * `createdAt` rather than arrival time so a message that reached this process
   * late is aged from when it was actually posted. That is what makes the
   * staleness rule mean "this question is old" rather than "this socket is
   * slow".
   */
  static askedAt(message, now) {
    const parsed = Date.parse(String(message?.createdAt ?? ""));
    return Number.isFinite(parsed) ? parsed : now;
  }

  /**
   * Fold one inbound message in.
   *
   * Returns `{ tracked, cancelled, reason }` for the log and the tests:
   * `cancelled` is the id of a question this message answered, `tracked` is
   * true when this message became the channel's pending question.
   */
  observe(message, now = Date.now()) {
    const channelId = message?.channelId;
    if (!channelId) {
      return { tracked: false, cancelled: null, reason: "no-channel" };
    }
    if (!this.enabled) {
      return { tracked: false, cancelled: null, reason: "unprompted-disabled" };
    }

    // The bot's own message, seen coming back off the wire. It does not cancel
    // anything (the bot answering a mention has not answered somebody else's
    // question) and it does mean the newest thing in the room is the bot, which
    // is condition 6. `recordPost` sets the same flag locally; both paths are
    // kept because either one alone has a way of being missed.
    if (message.authorId && message.authorId === this.botUserId) {
      this.awaitingHuman.set(channelId, true);
      return { tracked: false, cancelled: null, reason: "self" };
    }

    // Other automation. Neutral on purpose: a sibling bot posting has not
    // answered anybody's question, and it is not a person being present either.
    const automated = isAutomatedAuthor(message, this.ignoreUserIds);
    if (automated) {
      return { tracked: false, cancelled: null, reason: automated };
    }

    // A person spoke, so the room is not waiting on the bot.
    this.awaitingHuman.delete(channelId);

    let cancelled = null;
    const current = this.pending.get(channelId);
    if (current) {
      if (current.authorId === message.authorId) {
        // The asker bumping their own question. Not an answer, and not a reset
        // of the clock either.
        return { tracked: false, cancelled: null, reason: "same-author" };
      }
      this.pending.delete(channelId);
      cancelled = current.id;
    }

    const verdict = looksLikeRoomQuestion(message);
    if (!verdict.ok) {
      return { tracked: false, cancelled, reason: verdict.reason };
    }

    this.pending.set(channelId, {
      id: message.id,
      channelId,
      authorId: message.authorId,
      authorName: message.authorName,
      body: String(message.body ?? ""),
      askedAt: PendingQuestions.askedAt(message, now),
    });
    return { tracked: true, cancelled, reason: "tracked" };
  }

  /**
   * The bot posted in this channel. Any kind of post: an answer, a hello, an
   * unprompted answer. Condition 6 is about what the room SEES, so it does not
   * care which path produced the message.
   */
  recordPost(channelId) {
    if (channelId) {
      this.awaitingHuman.set(channelId, true);
    }
  }

  /**
   * The oldest question that is ready to be answered, or null.
   *
   * Removes whatever it returns, and also removes anything it drops, so a
   * question is considered exactly once. Stale drops are reported through
   * `onDrop` rather than returned, because the caller's only sane response to
   * one is a log line.
   */
  due(now = Date.now(), onDrop = null) {
    let best = null;
    for (const candidate of this.pending.values()) {
      const age = now - candidate.askedAt;
      if (age < this.delayMs) {
        continue;
      }
      if (age > this.maxAgeMs) {
        this.pending.delete(candidate.channelId);
        onDrop?.({ ...candidate, ageMs: age, reason: "stale" });
        continue;
      }
      // Condition 6. The bot's own message is the newest thing in the room, so
      // an unprompted line would be two of its messages in a row. Drop rather
      // than hold: by the time a person speaks again the question is old news,
      // and holding it is how a bot ends up answering into a new conversation.
      if (this.awaitingHuman.get(candidate.channelId)) {
        this.pending.delete(candidate.channelId);
        onDrop?.({ ...candidate, ageMs: age, reason: "awaiting-human" });
        continue;
      }
      if (!best || candidate.askedAt < best.askedAt) {
        best = candidate;
      }
    }
    if (best) {
      this.pending.delete(best.channelId);
    }
    return best;
  }

  /** Test and observability helper. */
  size() {
    return this.pending.size;
  }

  /** Test and observability helper. */
  forChannel(channelId) {
    return this.pending.get(channelId) ?? null;
  }
}

/**
 * The caps, checked after a question comes due and before the model is called.
 *
 * Separate from `screenTrigger` rather than a flag on it, because the two paths
 * have genuinely different ceilings and folding them together would mean one
 * function with a branch in every clause. What they DO share is the ledger:
 * `rateCap` is the same instance, so an unprompted answer spends the same
 * per-user and per-channel hourly budget as an answer somebody asked for, and
 * the total number of messages this account can post in an hour is unchanged by
 * this feature existing.
 *
 * Pure.
 */
export function screenUnprompted(candidate, context) {
  const {
    enabled = true,
    allowedChannelIds,
    rateCap,
    now = Date.now(),
    limits,
    unprompted,
    dailyCallsRemaining = Infinity,
    lastAnswerAt = 0,
  } = context;

  if (!enabled) {
    return { answer: false, reason: UNPROMPTED_SKIP.DISABLED };
  }
  if (allowedChannelIds && !allowedChannelIds.has(candidate.channelId)) {
    return { answer: false, reason: UNPROMPTED_SKIP.CHANNEL };
  }
  if (now - lastAnswerAt < limits.cooldownMs) {
    return { answer: false, reason: UNPROMPTED_SKIP.COOLDOWN };
  }
  if (!rateCap.allow(`user:${candidate.authorId}`, limits.maxPerUserPerHour, now)) {
    return { answer: false, reason: UNPROMPTED_SKIP.USER_CAP };
  }
  if (!rateCap.allow(`channel:${candidate.channelId}`, limits.maxPerChannelPerHour, now)) {
    return { answer: false, reason: UNPROMPTED_SKIP.CHANNEL_CAP };
  }
  if (
    !rateCap.allow(
      `unprompted:${candidate.channelId}`,
      unprompted.maxPerChannelPerHour,
      now,
    )
  ) {
    return { answer: false, reason: UNPROMPTED_SKIP.UNPROMPTED_CAP };
  }
  if (
    !rateCap.allow(
      `unprompted-try:${candidate.channelId}`,
      unprompted.maxTriesPerChannelPerHour,
      now,
    )
  ) {
    return { answer: false, reason: UNPROMPTED_SKIP.TRY_CAP };
  }
  if (dailyCallsRemaining <= 0) {
    return { answer: false, reason: UNPROMPTED_SKIP.DAILY_CAP };
  }
  // The reserve, checked last so the more specific reasons win the log line.
  if (dailyCallsRemaining <= unprompted.budgetReserve) {
    return { answer: false, reason: UNPROMPTED_SKIP.BUDGET_RESERVE };
  }

  return { answer: true };
}
