/**
 * Locadora's own words. The platform-facing ones (name, description, presence
 * line, notice) live in the manifest.
 *
 * Rule 1 of docs/EMULATOR_ROOM.md applies to every line here: nothing may name
 * a game, suggest where one comes from, or imply anything about how a file was
 * obtained. "Bring a game you have the right to play" is the whole of it.
 */
export interface Strings {
  title: string;
  connecting: string;
  online: string;
  reconnecting: string;
  outside: string;
  ended: string;
  intro: string;
  privacy: string;
  rights: string;
  systems: string;
  solo: string;
  choose: string;
  chooseAnother: string;
  loading: string;
  startHint: string;
  controlsTitle: string;
  controlsHide: string;
  noticesTitle: string;
  noticesHide: string;
  noticesIntro: string;
  noticesLoading: string;
  noticesFailed: string;
  controlDpad: string;
  controlA: string;
  controlB: string;
  controlStart: string;
  controlSelect: string;
  controlShoulders: string;
  controlGamepad: string;
  fullscreen: string;
  exitFullscreen: string;
  problemUnsupported: string;
  problemTooBig: string;
  problemLoad: string;
  frameTitle: string;
}

export const STRINGS = {
  "pt-BR": {
    title: "Locadora",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    outside: "Abre a Locadora dentro do pqp.",
    ended: "A sessão acabou.",
    intro:
      "Isso aqui é só um emulador. O pqp não fornece jogo nenhum. Escolhe o arquivo de um jogo no teu computador e ele roda aqui mesmo.",
    privacy:
      "O arquivo fica no teu navegador. Ele nunca é enviado, nem pro pqp nem pra lugar nenhum, nem salvo, e some quando tu sair daqui.",
    rights: "Abre só jogo que tu tem direito de jogar, tipo um que tu comprou ou um homebrew.",
    systems: "Roda arquivos de NES, Game Boy, Game Boy Color e Game Boy Advance (.nes, .gb, .gbc, .gba).",
    solo: "Cada pessoa joga o seu no seu computador: o pqp não mostra o teu jogo pra mais ninguém.",
    choose: "Escolher jogo",
    chooseAnother: "Escolher outro jogo",
    loading: "Carregando o emulador...",
    startHint: "Clica em Iniciar jogo pra começar. O som só liga depois desse clique.",
    controlsTitle: "Controles",
    controlsHide: "Esconder controles",
    noticesTitle: "Licenças",
    noticesHide: "Esconder licenças",
    noticesIntro:
      "Software de terceiros que a Locadora usa, com a licença de cada um e o link do código-fonte.",
    noticesLoading: "Carregando as licenças...",
    noticesFailed: "Não deu pra carregar as licenças. Tenta de novo.",
    controlDpad: "Setas: direcional",
    controlA: "Z: botão A",
    controlB: "X: botão B",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q e E: L e R (Game Boy Advance)",
    controlGamepad: "Um controle (gamepad) conectado é reconhecido sozinho.",
    fullscreen: "Tela cheia",
    exitFullscreen: "Sair da tela cheia",
    problemUnsupported: "Esse arquivo não dá pra abrir. Escolhe um .nes, .gb, .gbc ou .gba.",
    problemTooBig: "Esse arquivo é grande demais pra esses consoles.",
    problemLoad: "O emulador não conseguiu iniciar. Tenta de novo.",
    frameTitle: "Emulador",
  },
  en: {
    title: "Locadora",
    connecting: "Connecting...",
    online: "Connected",
    reconnecting: "Reconnecting...",
    outside: "Open Locadora inside pqp.",
    ended: "The session is over.",
    intro:
      "This is only an emulator. pqp does not provide any game. Pick a game file on your computer and it runs right here.",
    privacy:
      "The file stays in your browser. It is never sent, not to pqp and not anywhere else, never saved, and it is gone when you leave.",
    rights: "Only open a game you have the right to play, like one you bought or a homebrew.",
    systems: "It runs NES, Game Boy, Game Boy Color and Game Boy Advance files (.nes, .gb, .gbc, .gba).",
    solo: "Everyone plays their own on their own computer: pqp does not show your game to anyone else.",
    choose: "Pick a game",
    chooseAnother: "Pick another game",
    loading: "Loading the emulator...",
    startHint: "Click Start Game to begin. Sound only turns on after that click.",
    controlsTitle: "Controls",
    controlsHide: "Hide controls",
    noticesTitle: "Licenses",
    noticesHide: "Hide licenses",
    noticesIntro:
      "Third-party software Locadora uses, with each one's license and a link to its source code.",
    noticesLoading: "Loading the licenses...",
    noticesFailed: "The licenses could not be loaded. Try again.",
    controlDpad: "Arrow keys: directional pad",
    controlA: "Z: A button",
    controlB: "X: B button",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q and E: L and R (Game Boy Advance)",
    controlGamepad: "A connected controller (gamepad) is picked up on its own.",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    problemUnsupported: "That file cannot be opened. Pick a .nes, .gb, .gbc or .gba.",
    problemTooBig: "That file is too big for these consoles.",
    problemLoad: "The emulator could not start. Try again.",
    frameTitle: "Emulator",
  },
  es: {
    title: "Locadora",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    outside: "Abre Locadora dentro de pqp.",
    ended: "La sesión terminó.",
    intro:
      "Esto es solo un emulador. pqp no proporciona ningún juego. Elige el archivo de un juego en tu computadora y corre aquí mismo.",
    privacy:
      "El archivo se queda en tu navegador. Nunca se envía, ni a pqp ni a ningún lado, no se guarda, y desaparece cuando salgas.",
    rights: "Abre solo un juego que tengas derecho a jugar, como uno que compraste o un homebrew.",
    systems: "Corre archivos de NES, Game Boy, Game Boy Color y Game Boy Advance (.nes, .gb, .gbc, .gba).",
    solo: "Cada persona juega el suyo en su computadora: pqp no le muestra tu juego a nadie más.",
    choose: "Elegir juego",
    chooseAnother: "Elegir otro juego",
    loading: "Cargando el emulador...",
    startHint: "Haz clic en Iniciar juego para empezar. El sonido solo se activa después de ese clic.",
    controlsTitle: "Controles",
    controlsHide: "Ocultar controles",
    noticesTitle: "Licencias",
    noticesHide: "Ocultar licencias",
    noticesIntro:
      "Software de terceros que usa Locadora, con la licencia de cada uno y el enlace a su código fuente.",
    noticesLoading: "Cargando las licencias...",
    noticesFailed: "No se pudieron cargar las licencias. Prueba otra vez.",
    controlDpad: "Flechas: cruceta",
    controlA: "Z: botón A",
    controlB: "X: botón B",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q y E: L y R (Game Boy Advance)",
    controlGamepad: "Un control (gamepad) conectado se reconoce solo.",
    fullscreen: "Pantalla completa",
    exitFullscreen: "Salir de pantalla completa",
    problemUnsupported: "Ese archivo no se puede abrir. Elige un .nes, .gb, .gbc o .gba.",
    problemTooBig: "Ese archivo es demasiado grande para estas consolas.",
    problemLoad: "El emulador no pudo iniciar. Prueba otra vez.",
    frameTitle: "Emulador",
  },
} as const satisfies Record<string, Strings>;

export type LocadoraLocale = keyof typeof STRINGS;

/** Exact match first, then the base language, then English. */
export function pickLocale(locale: string): LocadoraLocale {
  if (Object.hasOwn(STRINGS, locale)) return locale as LocadoraLocale;
  const base = locale.split("-")[0]?.toLowerCase();
  if (base === "pt") return "pt-BR";
  if (base === "es") return "es";
  return "en";
}

/** The language EmulatorJS draws its own menus in; the rest stay English. */
export const EMULATOR_LANGUAGE: Record<LocadoraLocale, "pt-BR" | "es-ES" | "en-US"> = {
  "pt-BR": "pt-BR",
  es: "es-ES",
  en: "en-US",
};
