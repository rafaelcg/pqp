/**
 * What `manual [bot]` says back when somebody new says oi.
 *
 * ── THIS FILE IS COPY, NOT LOGIC ─────────────────────────────────────────────
 *
 * Edit it the way you would edit `facts.md`: a human writes every line, and the
 * bot picks one at random and fills in `{name}`. There is no model anywhere
 * near this. That is the same no-improvisation rule the answers follow, applied
 * to the one moment where the bot speaks to somebody who did not ask it a
 * question: a person who just walked into the room and said hello.
 *
 * The register is a friend answering "oi" from the couch, not a receptionist.
 * Short, warm, a little silly. A few lines lean into being a bot on purpose,
 * because the account is disclosed and the copy should sit comfortably next to
 * the `[bot]` in its name rather than pretend the label is not there.
 *
 * Rules for adding a line, and `test/greetings.test.js` checks the mechanical
 * ones:
 *
 *   - `{name}` appears exactly once. It becomes `@username` when the person has
 *     one and their display name when they do not.
 *   - Never an em dash.
 *   - Never a joke at the newcomer, their name, or anybody else. Nothing about
 *     looks, gender or where somebody is from, which also means no gendered
 *     "bem-vindo(a)": say "boas-vindas" or say nothing.
 *   - No inside jokes that need history and no claims about the product. A
 *     greeting that says "aqui a call nunca cai" is a promise the fact file did
 *     not make.
 *   - It has to read as an ANSWER to a hello, not an announcement of an
 *     arrival. The bot only ever posts one of these as a reply to the person's
 *     own message.
 */

export const HELLO_REPLIES = [
  "opa, {name}! chegou! senta que o chão é de todos.",
  "oi {name}! regra da casa: quem chega diz oi. você já cumpriu, tá liberado.",
  "oi oi, {name}! pega um café aí. é imaginário, mas é quentinho.",
  "eaí {name}! sou o bot da casa, a parte humana do QG chega já.",
  "salve, {name}! se travar em algo, conta. aqui se resolve na conversa.",
  "oi {name}! que bom que você chegou. o QG ficou mais animado agora.",
  "{name} entrou no QG. isso não é um treinamento. repito: não é um treinamento.",
  "olá {name}! comunicado solene: a casa é sua. só não muda a senha do wifi.",
  "oi {name}!! (o segundo ponto de exclamação é por conta da casa)",
  "opa {name}, chegou na hora certa. não tem hora errada, mas você chegou na certa.",
  "fala {name}! conta o que te trouxe aqui, a gente gosta de história.",
  "{name}! sou um bot, então dizer oi de volta é literalmente a minha melhor habilidade. oi!",
  "boas-vindas, {name}! aqui o mute é sagrado e o oi é obrigatório. você já passou na prova.",
  "oi {name}! qualquer coisa, grita. em texto, de preferência.",
  "{name}, oi! puxa uma cadeira. a conversa aqui não tem começo nem fim, entra em qualquer ponto.",
  "chegou {name}! informo que os biscoitos são de mentira, mas a recepção é de verdade.",
  "oi {name}! senha do QG: não tem. entrou, é de casa.",
  "eaí {name}! dá um alô pro pessoal e fica à vontade, aqui ninguém morde. eu nem tenho dente.",
  "olá {name}. sou o bot da recepção, então oficialmente: recepção feita. o resto do QG é gente de verdade.",
  "{name}!! oi! bom demais ter gente nova por aqui.",
  "oi {name}! se perder alguma coisa, pergunta. se achar alguma coisa, conta.",
  "opa, {name}! oi de volta, com juros. tá em casa.",
];
