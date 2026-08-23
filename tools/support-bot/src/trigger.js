/**
 * Should the bot answer this message at all?
 *
 * Pure. Every "no" carries a reason, because a bot that stays silent for
 * reasons nobody can read is a bot nobody can tune or trust.
 *
 * ── THE TRIGGER DECISION ────────────────────────────────────────────────────
 *
 * It answers ONLY when explicitly addressed: an `@mention` of its own username,
 * or a reply to one of its own messages. It does NOT answer every question in
 * `#ajuda`, and that was the real choice here.
 *
 * The case for "any question in #ajuda" is that it catches people who do not
 * know the bot exists, which is most people. The case against it is stronger,
 * and it has three parts:
 *
 *   1. IN #AJUDA, TWO HUMANS HELPING EACH OTHER IS THE BEST OUTCOME. The
 *      channel topic is "pergunta aqui que alguém responde". A bot that answers
 *      first, every time, teaches the room that answering is handled, and a
 *      community that stops answering its own questions does not start again.
 *      The bot is meant to cover the questions Rafael cannot reach, not to
 *      occupy the ones the room would have reached first.
 *   2. QUESTION DETECTION MISFIRES CONSTANTLY IN CHAT. "alguém aí?", "viu
 *      isso?", "tá on?" are all questions and none of them is for the bot. Each
 *      misfire is the bot inserting itself into a conversation between two
 *      people who did not ask, which is precisely the "simulating a presence"
 *      failure the whole design is supposed to avoid.
 *   3. A MENTION IS CONSENT, AND CONSENT IS THE ETHICAL BASIS OF THE WHOLE
 *      THING. This account exists because a support bot is honest in a way an
 *      undisclosed resident is not. Somebody typing its name has decided to
 *      talk to software. Nobody asking a question in a room has decided
 *      anything.
 *
 * The cost is discoverability, and it is real. The mitigation is deliberately
 * NOT a bot behaviour: the channel topic and the pinned welcome post say the
 * bot exists and how to call it. The room announces the bot. The bot does not
 * announce itself, because an account that introduces itself unprompted is
 * doing ambient chatter under another name.
 *
 * A reply to one of its own messages counts as addressing it, because that is
 * how a follow-up question is actually typed and requiring a second `@` for
 * "e no firefox?" would be pedantry with a cost.
 */

/**
 * Reasons, as constants, so the log and the tests cannot disagree about
 * spelling.
 */
export const SKIP = {
  SELF: "self",
  BOT_AUTHOR: "bot-author",
  WEBHOOK: "webhook",
  IGNORED_AUTHOR: "ignored-author",
  CHANNEL: "channel-not-allowed",
  NOT_ADDRESSED: "not-addressed",
  EMPTY: "empty",
  TOO_LONG: "too-long",
  DUPLICATE: "duplicate",
  COOLDOWN: "cooldown",
  USER_CAP: "user-cap",
  CHANNEL_CAP: "channel-cap",
  DAILY_CAP: "daily-cap",
};

/** Longest question the bot will read. Past this it is a paste, not a question. */
const MAX_QUESTION_CHARS = 600;

/**
 * Is this message addressed to the bot?
 *
 * `@username` is matched on the mention grammar the product actually uses
 * (`MENTION_PATTERN` in `@pqp/shared`: `@` plus 2 to 32 of `[A-Za-z0-9_]`),
 * lowercased on both sides. Matching on display name instead would be wrong:
 * the display name is "manual [bot]", it contains a space and a bracket, and
 * it is not what the client inserts when somebody picks the bot from the
 * autocomplete.
 */
export function isAddressed(message, { botUserId, botUsername }) {
  if (message.replyTo && message.replyTo.authorId === botUserId) {
    return "reply";
  }
  if (!botUsername) {
    return null;
  }
  const pattern = new RegExp(`@${escapeRegex(botUsername)}(?![A-Za-z0-9_])`, "i");
  return pattern.test(String(message.body ?? "")) ? "mention" : null;
}

/**
 * The whole inbound gate, in one call.
 *
 * ── LOOPS AND FLOODING ──────────────────────────────────────────────────────
 *
 * Five independent things stop this account talking to itself or drowning a
 * channel, and they are independent on purpose: each one fails differently, so
 * a bug in one does not open the others.
 *
 *   1. STRUCTURAL. It only answers when addressed. A loop needs another account
 *      to deliberately type its name, which no accident produces.
 *   2. IDENTITY. Its own user id is refused first, before anything else runs.
 *      This is the one that makes a loop impossible rather than merely
 *      unlikely, and it is checked before the trigger so that even a bot that
 *      somehow @-mentions itself cannot start one.
 *   3. OTHER AUTOMATION. Webhook messages and any configured `ignoreUserIds`
 *      are refused, so two bots in one room cannot get into a conversation.
 *      Bot-to-bot is the classic way a channel fills with garbage overnight.
 *   4. RATE. Per user per hour, per channel per hour, and a global cooldown
 *      between any two answers. The per-user cap is what stops one person
 *      spending the entire budget; the per-channel cap is what stops the room
 *      becoming a transcript of the bot; the cooldown is what stops a burst.
 *   5. BUDGET. A hard daily ceiling on model calls, checked here so an
 *      exhausted budget is a normal, logged skip rather than an exception.
 *
 * `rateCap` is the ambient runner's `RateCap`, reused rather than rewritten.
 */
export function screenTrigger(message, context) {
  const {
    botUserId,
    botUsername,
    allowedChannelIds,
    ignoreUserIds = new Set(),
    rateCap,
    seen,
    now = Date.now(),
    limits,
    dailyCallsRemaining = Infinity,
    lastAnswerAt = 0,
  } = context;

  // FIRST, ALWAYS. Everything else is a policy; this is the thing that makes a
  // self-loop impossible, so nothing gets to run in front of it.
  if (message.authorId === botUserId) {
    return { answer: false, reason: SKIP.SELF };
  }
  if (message.isWebhook) {
    return { answer: false, reason: SKIP.WEBHOOK };
  }
  if (ignoreUserIds.has(message.authorId)) {
    return { answer: false, reason: SKIP.IGNORED_AUTHOR };
  }
  // Any account whose display name is marked as automated. Belt and braces
  // next to `ignoreUserIds`: the house cast carries " [bot]" by construction
  // (`disclosureLabel`), so this catches a sibling bot nobody remembered to add
  // to the ignore list.
  if (/\[bot\]\s*$/i.test(String(message.authorName ?? ""))) {
    return { answer: false, reason: SKIP.BOT_AUTHOR };
  }

  if (allowedChannelIds && !allowedChannelIds.has(message.channelId)) {
    return { answer: false, reason: SKIP.CHANNEL };
  }

  const how = isAddressed(message, { botUserId, botUsername });
  if (!how) {
    return { answer: false, reason: SKIP.NOT_ADDRESSED };
  }

  const question = stripMention(message.body, botUsername);
  if (question.length === 0) {
    return { answer: false, reason: SKIP.EMPTY };
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return { answer: false, reason: SKIP.TOO_LONG };
  }

  // Restart safety and broadcast echo. The socket can deliver the same message
  // twice across a reconnect, and answering a question twice reads as a bug in
  // the product rather than in the bot.
  if (seen?.has(message.id)) {
    return { answer: false, reason: SKIP.DUPLICATE };
  }

  if (now - lastAnswerAt < limits.cooldownMs) {
    return { answer: false, reason: SKIP.COOLDOWN };
  }
  if (!rateCap.allow(`user:${message.authorId}`, limits.maxPerUserPerHour, now)) {
    return { answer: false, reason: SKIP.USER_CAP };
  }
  if (
    !rateCap.allow(`channel:${message.channelId}`, limits.maxPerChannelPerHour, now)
  ) {
    return { answer: false, reason: SKIP.CHANNEL_CAP };
  }
  if (dailyCallsRemaining <= 0) {
    return { answer: false, reason: SKIP.DAILY_CAP };
  }

  return { answer: true, how, question };
}

/**
 * The question without the bot's own name in it.
 *
 * Sent to the model rather than the raw body so the prompt does not spend its
 * first tokens teaching the model to ignore a mention token, and so "@manual_bot"
 * never appears in a transcript the model might echo back into an answer.
 */
export function stripMention(body, botUsername) {
  let text = String(body ?? "");
  if (botUsername) {
    text = text.replace(
      new RegExp(`@${escapeRegex(botUsername)}(?![A-Za-z0-9_])`, "gi"),
      " ",
    );
  }
  return text.replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
