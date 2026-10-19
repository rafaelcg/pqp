/** Enquete's own words. The platform-facing ones (name, presence line, notice) live in the manifest. */
export interface Strings {
  title: string;
  connecting: string;
  online: string;
  reconnecting: string;
  ended: string;
  outside: string;
  failed: string;
  cannotVote: string;
  waiting: string;
  waitingHint: string;
  setupTitle: string;
  questionLabel: string;
  questionPlaceholder: string;
  optionsLabel: string;
  /** `{n}` is the option's position. */
  optionLabel: string;
  optionPlaceholder: string;
  addOption: string;
  removeOption: string;
  modeLabel: string;
  modeSingle: string;
  modeMulti: string;
  start: string;
  starting: string;
  errQuestion: string;
  errOptions: string;
  errDuplicate: string;
  errCharacters: string;
  errTooLong: string;
  hintSingle: string;
  hintMulti: string;
  clearVote: string;
  /** `{n}` is how many people voted. */
  votersOne: string;
  votersOther: string;
  nobodyYet: string;
  /** `{n}` is the votes one option got (for screen readers). */
  votesOne: string;
  votesOther: string;
  closeVote: string;
  closeAsk: string;
  closeConfirm: string;
  closeCancel: string;
  closedBanner: string;
  /** `{names}` is one or more option names. */
  winner: string;
  tie: string;
  noWinner: string;
  endPoll: string;
  hostOnlyClose: string;
  hostOnlyEnd: string;
  yourVote: string;
}

export const STRINGS = {
  "pt-BR": {
    title: "Enquete",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    ended: "A enquete acabou.",
    outside: "Abre a Enquete dentro do pqp.",
    failed: "Não deu certo. Tenta de novo.",
    cannotVote: "Quem tá só assistindo não vota nesta sessão.",
    waiting: "O host tá montando a enquete...",
    waitingHint: "Assim que ele começar, tu vota aqui.",
    setupTitle: "Monta a enquete",
    questionLabel: "Pergunta",
    questionPlaceholder: "O que tu quer saber?",
    optionsLabel: "Opções",
    optionLabel: "Opção {n}",
    optionPlaceholder: "Opção {n}",
    addOption: "Adicionar opção",
    removeOption: "Tirar opção {n}",
    modeLabel: "Como se vota",
    modeSingle: "Uma opção só",
    modeMulti: "Quantas quiser",
    start: "Começar votação",
    starting: "Começando...",
    errQuestion: "Escreve a pergunta.",
    errOptions: "Precisa de 2 a 10 opções.",
    errDuplicate: "Tem opção repetida.",
    errCharacters: "Tem um caractere que não dá pra usar.",
    errTooLong: "Tem texto grande demais.",
    hintSingle: "Escolhe uma opção.",
    hintMulti: "Escolhe quantas quiser.",
    clearVote: "Tirar meu voto",
    votersOne: "{n} pessoa votou",
    votersOther: "{n} pessoas votaram",
    nobodyYet: "Ninguém votou ainda.",
    votesOne: "{n} voto",
    votesOther: "{n} votos",
    closeVote: "Encerrar votação",
    closeAsk: "Encerrar a votação? Ninguém mais vota.",
    closeConfirm: "Encerrar",
    closeCancel: "Voltar",
    closedBanner: "Votação encerrada",
    winner: "Venceu: {names}",
    tie: "Empate: {names}",
    noWinner: "Ninguém votou.",
    endPoll: "Encerrar enquete",
    hostOnlyClose: "Só o host encerra a votação.",
    hostOnlyEnd: "O host encerra a enquete quando quiser.",
    yourVote: "teu voto",
  },
  en: {
    title: "Poll",
    connecting: "Connecting...",
    online: "Connected",
    reconnecting: "Reconnecting...",
    ended: "The poll is over.",
    outside: "Open Poll inside pqp.",
    failed: "That did not work. Try again.",
    cannotVote: "People who are only watching cannot vote in this session.",
    waiting: "The host is setting up the poll...",
    waitingHint: "As soon as they start, you vote here.",
    setupTitle: "Set up the poll",
    questionLabel: "Question",
    questionPlaceholder: "What do you want to know?",
    optionsLabel: "Options",
    optionLabel: "Option {n}",
    optionPlaceholder: "Option {n}",
    addOption: "Add option",
    removeOption: "Remove option {n}",
    modeLabel: "How people vote",
    modeSingle: "One option only",
    modeMulti: "As many as they like",
    start: "Start the vote",
    starting: "Starting...",
    errQuestion: "Write the question.",
    errOptions: "It needs 2 to 10 options.",
    errDuplicate: "An option is repeated.",
    errCharacters: "There is a character that cannot be used.",
    errTooLong: "Some text is too long.",
    hintSingle: "Pick one option.",
    hintMulti: "Pick as many as you like.",
    clearVote: "Take my vote back",
    votersOne: "{n} person voted",
    votersOther: "{n} people voted",
    nobodyYet: "Nobody has voted yet.",
    votesOne: "{n} vote",
    votesOther: "{n} votes",
    closeVote: "Close the vote",
    closeAsk: "Close the vote? Nobody else can vote.",
    closeConfirm: "Close",
    closeCancel: "Back",
    closedBanner: "Vote closed",
    winner: "Winner: {names}",
    tie: "Tie: {names}",
    noWinner: "Nobody voted.",
    endPoll: "End the poll",
    hostOnlyClose: "Only the host closes the vote.",
    hostOnlyEnd: "The host ends the poll when they want.",
    yourVote: "your vote",
  },
  es: {
    title: "Encuesta",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    ended: "La encuesta terminó.",
    outside: "Abre Encuesta dentro de pqp.",
    failed: "No funcionó. Prueba otra vez.",
    cannotVote: "Quien solo está mirando no vota en esta sesión.",
    waiting: "El host está armando la encuesta...",
    waitingHint: "En cuanto empiece, votas aquí.",
    setupTitle: "Arma la encuesta",
    questionLabel: "Pregunta",
    questionPlaceholder: "¿Qué quieres saber?",
    optionsLabel: "Opciones",
    optionLabel: "Opción {n}",
    optionPlaceholder: "Opción {n}",
    addOption: "Agregar opción",
    removeOption: "Quitar opción {n}",
    modeLabel: "Cómo se vota",
    modeSingle: "Una sola opción",
    modeMulti: "Las que quieran",
    start: "Empezar votación",
    starting: "Empezando...",
    errQuestion: "Escribe la pregunta.",
    errOptions: "Necesita de 2 a 10 opciones.",
    errDuplicate: "Hay una opción repetida.",
    errCharacters: "Hay un carácter que no se puede usar.",
    errTooLong: "Hay un texto demasiado largo.",
    hintSingle: "Elige una opción.",
    hintMulti: "Elige las que quieras.",
    clearVote: "Quitar mi voto",
    votersOne: "Votó {n} persona",
    votersOther: "Votaron {n} personas",
    nobodyYet: "Todavía no votó nadie.",
    votesOne: "{n} voto",
    votesOther: "{n} votos",
    closeVote: "Cerrar la votación",
    closeAsk: "¿Cerrar la votación? Nadie más vota.",
    closeConfirm: "Cerrar",
    closeCancel: "Volver",
    closedBanner: "Votación cerrada",
    winner: "Ganó: {names}",
    tie: "Empate: {names}",
    noWinner: "Nadie votó.",
    endPoll: "Terminar la encuesta",
    hostOnlyClose: "Solo el host cierra la votación.",
    hostOnlyEnd: "El host termina la encuesta cuando quiera.",
    yourVote: "tu voto",
  },
} as const satisfies Record<string, Strings>;

export type EnqueteLocale = keyof typeof STRINGS;

/** Exact match first, then the base language, then English. */
export function pickLocale(locale: string): EnqueteLocale {
  if (Object.hasOwn(STRINGS, locale)) return locale as EnqueteLocale;
  const base = locale.split("-")[0]?.toLowerCase();
  if (base === "pt") return "pt-BR";
  if (base === "es") return "es";
  return "en";
}

/** A plain splice: the slot's value can be a name a stranger typed, so no `$` patterns and no re-expansion. */
export function fill(template: string, slot: string, value: string): string {
  return template.split(`{${slot}}`).join(value);
}

/** "1 person voted" or "3 people voted", by the locale's own plural rule. */
export function votersLine(t: Strings, locale: string, n: number): string {
  const one = new Intl.PluralRules(locale).select(n) === "one";
  return fill(one ? t.votersOne : t.votersOther, "n", String(n));
}

export function votesLine(t: Strings, locale: string, n: number): string {
  const one = new Intl.PluralRules(locale).select(n) === "one";
  return fill(one ? t.votesOne : t.votesOther, "n", String(n));
}
