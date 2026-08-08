/**
 * Turning a scene plan into a prompt, and a model's answer back into messages.
 *
 * The cost model lives here in one decision: a scene is ONE API call that
 * produces the whole exchange, not one call per line. Four lines per call
 * turns ~4x the requests and ~4x the re-sent context into 1x of each, and it
 * is also what makes the dialogue cohere — the model can see the reply it is
 * setting up. Pure, like schedule.js, so the splitting rules are testable.
 */

/** The stable half of the prompt: world, cast, rules. Cacheable in principle. */
export function buildSystemPrompt(config, cast) {
  const { community, defaults } = config;
  const roster = cast
    .map(
      (p) =>
        `- ${p.displayName}: ${p.register.trim().replace(/\s+/g, " ")} ` +
        `Assuntos: ${p.interests.join(", ")}.`,
    )
    .join("\n");

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
    `- PROIBIDO dar conselho médico, jurídico ou financeiro.`,
    `- PROIBIDO combinar encontro presencial, pedir contato, ou dizer que vai ligar/chamar no zap.`,
    `- Ninguém menciona ser bot, IA, personagem ou programa. Também ninguém afirma ser humano.`,
    `- Não invente nomes, resultados ou notícias específicas de datas reais; fale de forma genérica.`,
  ].join("\n");
}

/** The volatile half: this scene's topic, memory, and any human to answer. */
export function buildUserPrompt({ topic, lines, cast, memory = {}, replyTo }) {
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
    parts.push(
      `IMPORTANTE: uma pessoa real acabou de escrever no canal:`,
      `"${replyTo.body}" — ${replyTo.authorName}`,
      `A primeira mensagem tem que responder essa pessoa de verdade, pelo nome,` +
        ` sobre o que ela disse. Depois a conversa segue.`,
    );
  }
  parts.push(
    `Responda apenas com as ${lines} linhas, nada antes e nada depois.`,
  );
  return parts.join("\n");
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
