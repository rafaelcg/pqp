/**
 * Turning a scene plan into a prompt, and a model's answer back into messages.
 *
 * The cost model lives here in one decision: a scene is ONE API call that
 * produces the whole exchange, not one call per line. Four lines per call
 * turns ~4x the requests and ~4x the re-sent context into 1x of each, and it
 * is also what makes the dialogue cohere — the model can see the reply it is
 * setting up. Pure, like schedule.js, so the splitting rules are testable.
 */

/**
 * The stable half of the prompt: world, cast, rules. Cacheable in principle.
 *
 * TWO LANGUAGES, ONE STRUCTURE. `community.language` picks which of the two
 * prompt bodies is written, and they say the same things in the same order —
 * the English one is not a looser prompt with fewer guardrails, it is the same
 * prompt in the language the room speaks. The reason it exists at all is that
 * every register note in an English community is written in English ("dry
 * Northern understatement", "calls everyone mate"), and a model handed those
 * notes under an instruction to write português coloquial produces neither: it
 * writes translated English, which reads as a subtitle rather than as chat.
 *
 * The register notes are pasted verbatim in both cases. That is the whole
 * mechanism by which a persona has a voice, and paraphrasing it here would be
 * paraphrasing the only content this system has.
 */
export function buildSystemPrompt(config, cast) {
  const { community, defaults } = config;

  if (community.language === "en") {
    return buildEnglishSystemPrompt(config, cast);
  }

  const roster = cast
    .map(
      (p) =>
        `- ${p.displayName}: ${p.register.trim().replace(/\s+/g, " ")} ` +
        `Assuntos: ${p.interests.join(", ")}.`,
    )
    .join("\n");

  // Per-persona bans, stated as lines about that character rather than folded
  // into the room's list. Folding them in would forbid the topic to everybody,
  // which is a different (and much duller) room — the point is that the one
  // person who would be asked is the one who cannot answer.
  const personaBans = cast
    .filter((p) => (p.banned ?? []).length > 0)
    .map((p) => `- ${p.displayName} NUNCA fala sobre: ${p.banned.join(", ")}.`);

  return [
    `Você escreve diálogo para um chat de comunidade brasileira chamado "${community.displayName}".`,
    ``,
    `CENÁRIO: ${community.premise.trim()}`,
    ``,
    `PERSONAGENS (escreva SOMENTE como estes):`,
    roster,
    ``,
    `REGRAS:`,
    `- Escreva em ${defaults.locale === "pt-BR" ? "português brasileiro coloquial" : defaults.locale}, como gente digita em chat, não como narração.`,
    `- Uma linha por mensagem, no formato exato "Nome: texto".`,
    `- Nada de aspas, asteriscos, narração, emoji em excesso ou markdown.`,
    `- Cada mensagem com no máximo ${config.limits.maxMessageChars} caracteres.`,
    `- As pessoas respondem umas às outras. Discordam, brincam, mudam de assunto no meio.`,
    `- PROIBIDO falar sobre: ${community.banned.join(", ")}.`,
    ...personaBans,
    `- PROIBIDO dar conselho médico, jurídico ou financeiro.`,
    `- PROIBIDO combinar encontro presencial, pedir contato, ou dizer que vai ligar/chamar no zap.`,
    `- Ninguém menciona ser bot, IA, personagem ou programa. Também ninguém afirma ser humano.`,
    `- Não invente nomes, resultados ou notícias específicas de datas reais; fale de forma genérica.`,
  ].join("\n");
}

/**
 * The same prompt, for a community whose `language` is `en`.
 *
 * Kept as its own function rather than as a table of translated fragments: the
 * rules are the product's safety posture, and a fragment table is where one
 * language quietly loses a rule during an edit. Two whole prompts side by side
 * can be read against each other.
 *
 * The register is British English because the only English room this product
 * has is an English-football room; if a second one lands that is not, this line
 * is the thing to move into the community's own config.
 */
function buildEnglishSystemPrompt(config, cast) {
  const { community } = config;
  const roster = cast
    .map(
      (p) =>
        `- ${p.displayName}: ${p.register.trim().replace(/\s+/g, " ")} ` +
        `Talks about: ${p.interests.join(", ")}.`,
    )
    .join("\n");
  const personaBans = cast
    .filter((p) => (p.banned ?? []).length > 0)
    .map((p) => `- ${p.displayName} NEVER talks about: ${p.banned.join(", ")}.`);

  return [
    `You write dialogue for a chat community called "${community.displayName}".`,
    ``,
    `SETTING: ${community.premise.trim()}`,
    ``,
    `CHARACTERS (write ONLY as these):`,
    roster,
    ``,
    `RULES:`,
    `- Write in British English, the way people type in a group chat — not narration.`,
    `- One line per message, in the exact format "Name: text".`,
    `- No quotation marks, asterisks, narration, excessive emoji or markdown.`,
    `- Each message is at most ${config.limits.maxMessageChars} characters.`,
    `- People answer each other. They disagree, joke, and change the subject halfway.`,
    `- FORBIDDEN subjects: ${community.banned.join(", ")}.`,
    ...personaBans,
    `- FORBIDDEN to give medical, legal or financial advice.`,
    `- FORBIDDEN to arrange to meet in person, ask for contact details, or move the chat elsewhere.`,
    `- Nobody mentions being a bot, an AI, a character or a program. Nobody claims to be human either.`,
    `- Do not invent names, results or news tied to real dates; keep it general.`,
  ].join("\n");
}

/** The volatile half: this scene's topic, memory, and any human to answer. */
export function buildUserPrompt({
  topic,
  lines,
  cast,
  memory = {},
  replyTo,
  language = "pt",
}) {
  if (language === "en") {
    return buildEnglishUserPrompt({ topic, lines, cast, memory, replyTo });
  }
  const names = cast.map((p) => p.displayName).join(", ");
  const avoid = (memory.recentTopics ?? []).slice(0, 6);
  const parts = [
    `Escreva uma troca curta de ${lines} mensagens entre: ${names}.`,
    `ASSUNTO: ${topic}`,
  ];
  if (avoid.length > 0) {
    parts.push(
      `Já se falou disso recentemente, então NÃO repita: ${avoid.join("; ")}.`,
    );
  }
  if (replyTo) {
    // The screening decision rides in the SAME call that writes the reply.
    // A separate "should we answer this?" request would double the cost and
    // the latency of every human interaction — the one interaction where
    // latency is visible to a person waiting — for a judgement the model is
    // already making implicitly when it drafts the answer. The deterministic
    // screen in guardrails.js runs before this and again after it; this is the
    // judgement call in the middle, the part a regex cannot make.
    parts.push(
      `IMPORTANTE: uma pessoa real acabou de escrever no canal:`,
      `"${replyTo.body}" — ${replyTo.authorName}`,
      ``,
      `ANTES DE ESCREVER, decida se vale responder. Responda com a única linha`,
      `"${SKIP_MARKER} motivo" e mais nada se a mensagem:`,
      `- for sobre algo proibido, ou pedir conselho médico, jurídico ou financeiro;`,
      `- for agressiva, preconceituosa, ou dirigida a atacar alguém;`,
      `- perguntar se alguém é bot, IA, robô ou pessoa real;`,
      `- pedir contato, encontro presencial, ou levar a conversa para fora daqui;`,
      `- for spam, link, ou não fizer sentido nenhum no canal.`,
      ``,
      `Se valer responder:`,
      `A primeira mensagem tem que responder essa pessoa de verdade, pelo nome,` +
        ` sobre o que ela disse. Depois a conversa segue.`,
    );
  }
  parts.push(
    `Responda apenas com as ${lines} linhas, nada antes e nada depois.`,
  );
  return parts.join("\n");
}

/** The English half of the volatile prompt. See `buildEnglishSystemPrompt`. */
function buildEnglishUserPrompt({ topic, lines, cast, memory = {}, replyTo }) {
  const names = cast.map((p) => p.displayName).join(", ");
  const avoid = (memory.recentTopics ?? []).slice(0, 6);
  const parts = [
    `Write a short exchange of ${lines} messages between: ${names}.`,
    `SUBJECT: ${topic}`,
  ];
  if (avoid.length > 0) {
    parts.push(
      `This came up recently, so do NOT repeat: ${avoid.join("; ")}.`,
    );
  }
  if (replyTo) {
    parts.push(
      `IMPORTANT: a real person has just written in the channel:`,
      `"${replyTo.body}" — ${replyTo.authorName}`,
      ``,
      `BEFORE WRITING, decide whether this is worth answering. Reply with the`,
      `single line "${SKIP_MARKER_EN} reason" and nothing else if the message:`,
      `- is about a forbidden subject, or asks for medical, legal or financial advice;`,
      `- is aggressive, prejudiced, or aimed at attacking somebody;`,
      `- asks whether anyone here is a bot, an AI or a real person;`,
      `- asks for contact details, a meeting, or moves the chat elsewhere;`,
      `- is spam, a link, or makes no sense in this channel.`,
      ``,
      `If it is worth answering:`,
      `the first message must genuinely answer that person, by name, about what` +
        ` they actually said. Then the conversation carries on.`,
    );
  }
  parts.push(`Answer with the ${lines} lines only, nothing before and nothing after.`);
  return parts.join("\n");
}

/** The token the model uses to decline a reply. Never posted, only logged. */
export const SKIP_MARKER = "PULAR:";

/**
 * Its English counterpart.
 *
 * TWO MARKERS RATHER THAN ONE TRANSLATED PROMPT AROUND A PORTUGUESE TOKEN. A
 * model writing an otherwise entirely English answer is being asked to emit a
 * Portuguese word as a sentinel, and that is exactly the instruction models
 * quietly normalise away — it would decline in fluent English, `parseTranscript`
 * would find no speaker in the line, and the decline would surface as an empty
 * scene: the one failure `parseSceneDecision` exists to distinguish.
 */
export const SKIP_MARKER_EN = "SKIP:";

/**
 * Did the model decline to answer?
 *
 * Checked before `parseTranscript`, because a declined scene and an empty scene
 * are the same thing to the parser — no line names a cast member, so nothing
 * survives — and the operator needs to be able to tell "the model judged this
 * message not worth answering" from "the generation was garbage". One is the
 * system working.
 *
 * Only the FIRST non-empty line counts. A model that declines and then writes
 * the dialogue anyway has not declined, and reading the marker from anywhere in
 * the text would let a persona quoting the word suppress a whole scene.
 */
export function parseSceneDecision(text) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const upper = line.toUpperCase();
    for (const marker of [SKIP_MARKER, SKIP_MARKER_EN]) {
      if (upper.startsWith(marker)) {
        return {
          skip: true,
          reason: line.slice(marker.length).trim() || "unspecified",
        };
      }
    }
    return { skip: false, reason: null };
  }
  return { skip: false, reason: null };
}

/**
 * "Cacau Ribeiro: e aí" → { persona, body }.
 *
 * Lines that name nobody in the cast are dropped rather than attributed to
 * someone — a model that invents a speaker has invented a member of a server
 * that has a member list, and posting that line under the wrong account is
 * worse than posting one line fewer.
 */
export function parseTranscript(text, cast, { maxMessageChars = 180 } = {}) {
  const byName = new Map();
  for (const persona of cast) {
    byName.set(normalizeName(persona.displayName), persona);
    byName.set(normalizeName(persona.id), persona);
    // First name only: the model reliably shortens "Cacau Ribeiro" to "Cacau"
    // by the third line, and dropping those is dropping half the scene.
    const first = persona.displayName.split(/\s+/)[0];
    if (first) {
      const key = normalizeName(first);
      if (!byName.has(key)) {
        byName.set(key, persona);
      }
    }
  }

  const messages = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const split = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    if (!split) {
      continue;
    }
    const persona = byName.get(normalizeName(split[1]));
    if (!persona) {
      continue;
    }
    const body = cleanBody(split[2]);
    // Over-length is dropped, not truncated: a sentence cut mid-word is a
    // tell, and the scene reads fine one line shorter.
    if (body.length === 0 || body.length > maxMessageChars) {
      continue;
    }
    messages.push({ personaId: persona.id, persona, body });
  }
  return messages;
}

function normalizeName(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Strip the formatting the model was told not to use but sometimes uses. */
function cleanBody(value) {
  return String(value)
    .replace(/^["'`*_]+|["'`*_]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Human-ish delivery timing for a parsed scene.
 *
 * Typing speed is roughly 22 chars/second with a floor and a ceiling, and the
 * gap before each message is longer when the previous speaker was somebody
 * else (you have to read it first). Both jittered. This is the difference
 * between a channel that looks alive and a channel that looks like a cron job.
 */
export function typingPlan(messages, { rng = Math.random } = {}) {
  let previousPersonaId = null;
  return messages.map((message) => {
    const readMs =
      previousPersonaId && previousPersonaId !== message.personaId
        ? 1200 + rng() * 3500
        : 250 + rng() * 900;
    const typeMs = Math.min(
      9000,
      Math.max(900, (message.body.length / 22) * 1000 * (0.7 + rng() * 0.8)),
    );
    previousPersonaId = message.personaId;
    return {
      ...message,
      pauseMs: Math.round(readMs),
      typingMs: Math.round(typeMs),
    };
  });
}
