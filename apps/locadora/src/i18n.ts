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
  share: string;
  shareStop: string;
  sharing: string;
  shareRefused: string;
  shareFailed: string;
  watchingTitle: string;
  /** `{names}` is the players' names, joined. */
  watchingLine: string;
  /** Appended after the names, `{n}` more people. */
  watchingMore: string;
  watchingEmpty: string;
  watchingHow: string;
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
  problemInvalid: string;
  problemLoad: string;
  /** The line under each problem's headline: what to do about it. */
  problemUnsupportedHint: string;
  problemTooBigHint: string;
  problemInvalidHint: string;
  problemLoadHint: string;
  /** The accessible name of the problem card's close button. */
  problemDismiss: string;
  frameTitle: string;
  /* the keys of the UX pass (SPEC 15 of the locadora-ux-pass) */
  "sign.sub": string;
  "top.pick": string;
  "top.usage": string;
  "continue.eyebrow": string;
  "continue.saved": string;
  "continue.go": string;
  "continue.pick": string;
  "rules.title": string;
  "rules.1": string;
  "rules.3": string;
  "shelf.title": string;
  "shelf.empty": string;
  "shelf.noStorage": string;
  "shelf.full": string;
  "shelf.remove.confirm": string;
  "name.ask": string;
  "name.default": string;
  "onb.1.title": string;
  "onb.3.title": string;
  "onb.3.body": string;
  "onb.pad.found": string;
  "onb.listen": string;
  "onb.4.title": string;
  "onb.next": string;
  "onb.skip": string;
  "remap.reserved": string;
  "remap.dup": string;
  "load.steps": string;
  "start.press": string;
  "hud.pause": string;
  "hud.save": string;
  "hud.load": string;
  "hud.saves": string;
  "hud.turbo": string;
  "hud.screen": string;
  "hud.controls": string;
  "hud.sound": string;
  "hud.full": string;
  "hud.fullAria": string;
  "hud.eject": string;
  "hud.barLabel": string;
  /** `{n}` is the slot, 1 to 4. */
  "hud.saveSlot": string;
  /** `{n}` is the slot, 1 to 4. */
  "hud.loadSlot": string;
  "hud.slotPrev": string;
  "hud.slotNext": string;
  /** `{n}` is the slot, 1 to 4. */
  "hud.slot": string;
  "hud.slotCurrent": string;
  "hud.savesAria": string;
  "hud.turboAria": string;
  /** `{n}` is the speed, 1.5 to 10 (written with a comma in the languages that do). */
  "hud.turboPill": string;
  "hud.turboMenu": string;
  /** The Turbo button while the speed is 1x: pressing it does nothing, and it says so. */
  "hud.turboAria1x": string;
  /** The little chevron beside Turbo that opens the speed popover. */
  "hud.turboCaret": string;
  /** The slider's own name. */
  "hud.turboSlider": string;
  /** The slider's spoken value; `{n}` is the speed, 1.5 to 10. */
  "hud.turboValue": string;
  /** The slider's spoken value at 1x. */
  "hud.turboValueOff": string;
  "hud.turboPresets": string;
  /** The note under the slider above 3x; `{n}` is 3. */
  "hud.turboMute": string;
  "hud.mute": string;
  "hud.unmute": string;
  "hud.exit": string;
  "hud.ejectAria": string;
  "hud.resume": string;
  /** `{time}` is the play time, like 1h12 or 12 min. */
  "hud.played": string;
  /** `{n}` is the speed, 1.5 to 10 (written with a comma in the languages that do). */
  /** Turbo was asked for at 1x. */
  "toast.turbo1x": string;
  "toast.turbo1xAction": string;
  "toast.saved": string;
  "toast.loaded": string;
  "toast.undo": string;
  "paused": string;
  "saves.sram": string;
  "saves.empty": string;
  "saves.oldCore": string;
  /* the saves drawer (L4); `{n}` is a slot number or a count, `{name}` a slot name, `{ago}` a relative time, `{used}` a size */
  "saves.title": string;
  "saves.close": string;
  "saves.auto": string;
  "saves.slot": string;
  "saves.autoHint": string;
  "saves.autoEmpty": string;
  "saves.saveHere": string;
  "saves.loadAria": string;
  "saves.saveAria": string;
  "saves.more": string;
  "saves.delete": string;
  "saves.originLocal": string;
  "saves.originPhone": string;
  "saves.tryAnyway": string;
  "saves.autoSwitch": string;
  "saves.sramAt": string;
  "saves.emptyThumb": string;
  "saves.usage": string;
  "screen.pixel": string;
  "screen.fit": string;
  "screen.tv": string;
  "screen.square": string;
  "screen.crt": string;
  "screen.ambient": string;
  "screen.bezel": string;
  "screen.scaleTitle": string;
  "screen.aspectTitle": string;
  /** `{k}` is the whole number of screen pixels per game pixel that fits. */
  "screen.pixelHint": string;
  "screen.fitHint": string;
  /** Once, on the first game of this device: the double click on the picture. */
  "err.core": string;
  "err.crash": string;
  "export.title": string;
  "export.lead": string;
  "export.choose": string;
  "export.choice.saves": string;
  "export.choice.savesHint": string;
  "export.choice.all": string;
  "export.choice.allHint": string;
  "export.size": string;
  "export.sizeNone": string;
  "export.cloud": string;
  "export.noCloud": string;
  "export.privacy": string;
  "export.save": string;
  "export.importLead": string;
  "export.importButton": string;
  "export.importNotFile": string;
  "export.close": string;
  "export.empty": string;
  "export.failed": string;
  "export.tooBig": string;
  "export.done": string;
  "import.title": string;
  "import.games": string;
  "import.saves": string;
  "import.collision": string;
  "import.keep": string;
  "import.replace": string;
  "import.apply": string;
  "import.cancel": string;
  "import.missingFile": string;
  "import.notBundle": string;
  "import.tooBig": string;
  "import.full": string;
  "import.done": string;
  "import.failed": string;
  "sync.continue": string;
  "sync.conflict": string;
  "sync.both": string;
  "sync.device.computer": string;
  "sync.device.phone": string;
  "sync.device.tablet": string;
  "sync.from.computer": string;
  "sync.from.phone": string;
  "sync.from.tablet": string;
  "sync.this.computer": string;
  "sync.this.phone": string;
  "sync.this.tablet": string;
  "sync.useRemote": string;
  "sync.useLocal": string;
  "sync.later": string;
  "sync.bothFull": string;
  "sync.conflictSram": string;
  "sync.side": string;
  "sync.go": string;
  "sync.keepLocal": string;
  "sync.chip": string;
  "sync.chipBusy": string;
  "sync.chipError": string;
  "sync.chipReadOnly": string;
  "sync.note": string;
  "sync.noteReadOnly": string;
  "sync.usage": string;
  "sync.clear": string;
  "sync.clearAsk": string;
  "sync.clearYes": string;
  "sync.clearNo": string;
  "sync.cleared": string;
  "sync.clearFailed": string;
  "sync.chipNoStore": string;
  "sync.noteUnreachable": string;
  "sync.noteNoStore": string;
  "sync.retry": string;
  "sync.retrying": string;
  "sync.back": string;
  "sync.stillDown": string;
  "sync.badge": string;
  "sync.shelfChip": string;
  "rules.sync": string;
  /** The guest player (no account): where the shelf lives. */
  "rules.guest": string;
  "ended.synced": string;
  "gaveta.attest": string;
  /* the first visit and the controller map (L7) */
  "onb.1.sub": string;
  "onb.2.title": string;
  "onb.2.sub": string;
  "onb.3.sub": string;
  "onb.4.body": string;
  "onb.open": string;
  "onb.once": string;
  "onb.steps": string;
  "onb.step": string;
  "onb.back": string;
  "onb.close": string;
  "onb.cancel": string;
  "onb.reset": string;
  "onb.tabs": string;
  "onb.map": string;
  "remap.swap": string;
  "remap.keep": string;
  "pad.dpad": string;
  "pad.arrows": string;
  "pad.button": string;
  "pad.change": string;
  "pad.listening": string;
  "pad.up": string;
  "pad.down": string;
  "pad.left": string;
  "pad.right": string;
  /* the balcao: shelf, boxes, Ficha and name prompt (L6) */
  "rules.stamp": string;
  "shelf.filter": string;
  "shelf.filter.all": string;
  "shelf.sort": string;
  "shelf.sort.recent": string;
  "shelf.sort.name": string;
  "shelf.sort.console": string;
  "shelf.pickAnother": string;
  "shelf.hint": string;
  "box.new": string;
  "box.saves.one": string;
  "box.saves.other": string;
  "box.missing": string;
  "attach.mismatch": string;
  "ficha.selected": string;
  "ficha.play": string;
  "ficha.rename": string;
  "ficha.remove": string;
  "ficha.remove.yes": string;
  "ficha.remove.no": string;
  "ficha.never": string;
  "ficha.played": string;
  "ficha.playtime": string;
  "name.save": string;
  "name.skip": string;
  "continue.badge": string;
  /* L8: the start of a game, the continue prompt and the error table (SPEC 4.3, 4.7) */
  "continue.savedNow": string;
  "continue.badgeNow": string;
  "ficha.playedNow": string;
  "err.crashNow": string;
  "top.usageEmpty": string;
  /** The meter's short line on the top bar; `top.usage` is what it says to assistive tech. */
  "top.usageShort": string;
  "onb.replay": string;
  "hud.more": string;
  "hud.moreAria": string;
  "start.btn": string;
  "continue.prompt": string;
  "continue.fresh": string;
  "err.retry": string;
  "err.back": string;
  "err.storage": string;
  "err.openShelf": string;
  "err.badState": string;
  "load.aria": string;
  /* polish-insert: the way back from the load overlay, before the game starts */
  "load.back": string;
  "load.backAria": string;
  "toast.loadedAuto": string;
  "err.saveFailed": string;
  "err.crashNoSave": string;
  "err.crashLoad": string;
}

export const STRINGS = {
  "pt-BR": {
    title: "Locadora",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    outside: "Abre a Locadora dentro do pqp.",
    ended: "A sessão acabou. Teus saves ficaram guardados neste aparelho.",
    intro:
      "Isso aqui é só um emulador. O pqp não fornece jogo nenhum. Escolhe o arquivo de um jogo no teu computador e ele roda aqui mesmo.",
    privacy:
      "O arquivo fica neste aparelho. Ele nunca é enviado, nem pro pqp nem pra lugar nenhum.",
    rights: "Abre só jogo que tu tem direito de jogar, tipo um que tu comprou ou um homebrew.",
    systems: "Roda arquivos de NES, SNES, Game Boy, Game Boy Color e Game Boy Advance (.nes, .sfc, .smc, .gb, .gbc, .gba).",
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
      "Software de terceiros que a Locadora usa, com a licença de cada um e o link do código-fonte. As artes foram geradas com o Google Gemini (Nano Banana 2.1) a partir de prompts nossos.",
    noticesLoading: "Carregando as licenças...",
    noticesFailed: "Não deu pra carregar as licenças. Tenta de novo.",
    share: "Compartilhar",
    shareStop: "Parar de compartilhar",
    sharing: "A tela da Locadora tá sendo compartilhada. Quem entrar pra assistir vê o que tu vê aqui.",
    shareRefused: "Compartilhar tá desligado aqui.",
    shareFailed: "Não deu pra compartilhar agora. Tenta de novo.",
    watchingTitle: "Tu tá assistindo",
    watchingLine: "Aparece a tela do jogo de {names}.",
    watchingMore: " e mais {n}",
    watchingEmpty: "Ainda não tem ninguém jogando.",
    watchingHow: "Cada jogo roda no computador de quem joga. O pqp só passa a imagem.",
    controlDpad: "Setas: direcional",
    controlA: "Z: botão A",
    controlB: "X: botão B",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q e E: L e R (SNES e Game Boy Advance)",
    controlGamepad: "Um controle (gamepad) conectado é reconhecido sozinho.",
    fullscreen: "Tela cheia",
    exitFullscreen: "Sair da tela cheia",
    problemUnsupported: "Essa fita não entra nesse console.",
    problemTooBig: "Essa fita é grande demais pra esses consoles.",
    problemInvalid: "Esse arquivo não é uma fita que o console consiga ler.",
    problemLoad: "O emulador não conseguiu iniciar.",
    problemUnsupportedHint: "Aceita .nes, .sfc, .smc, .gb, .gbc, .gba.",
    problemTooBigHint: "Bota outra: a Locadora roda .nes, .sfc, .smc, .gb, .gbc e .gba.",
    problemInvalidHint: "Bota outra: a Locadora roda .nes, .sfc, .smc, .gb, .gbc e .gba.",
    problemLoadHint: "Tenta de novo, ou bota outra fita.",
    problemDismiss: "Fechar o aviso",
    frameTitle: "Emulador",
    // the UX pass (locadora-ux-pass SPEC 15). `intro`, `privacy` and `ended` above keep today's truthful text
    // until the device library exists; the onboarding and shelf tasks reword them with these.
    "sign.sub": "a prateleira é tua",
    "top.pick": "Botar fita",
    "top.usage": "Neste aparelho: {used} de {cap}",
    "continue.eyebrow": "Continuar de onde parou",
    "continue.saved": "salvo sozinho há {ago}",
    "continue.go": "Continuar",
    "continue.pick": "Escolher save",
    "rules.title": "Regras da casa",
    "rules.1": "A gente não aluga nem fornece jogo nenhum. A prateleira é só das fitas que tu trouxer.",
    "rules.3": "Bota só jogo que tu tem direito de jogar: um que tu comprou ou um homebrew.",
    "shelf.title": "Tua prateleira",
    "shelf.empty": "Prateleira vazia. Bota a primeira fita.",
    "shelf.noStorage": "Esse navegador não deixa guardar as fitas. Dá pra jogar, mas elas somem quando tu sair.",
    "shelf.full": "Tá quase cheio. Tira umas fitas da prateleira pra caber mais.",
    "shelf.remove.confirm": "A fita e os saves dela somem deste aparelho.",
    "name.ask": "Como chama essa fita?",
    "name.default": "Fita sem nome {n}",
    "onb.1.title": "Entra, a casa é tua",
    "onb.3.title": "Pega o controle, tchê",
    "onb.3.body": "Esse é o mapa do controle. Clica num botão pra trocar a tecla dele. Se tu tiver um gamepad, é só apertar qualquer botão nele.",
    "onb.pad.found": "Achei um gamepad! Já tá funcionando.",
    "onb.listen": "Aperta a tecla pro botão {button}...",
    "onb.4.title": "Bota a primeira fita",
    "onb.next": "Bora, próximo",
    "onb.skip": "Pular tudo",
    "remap.reserved": "Essa tecla é dos atalhos da Locadora.",
    "remap.dup": "{key} já é o botão {button}. Troca?",
    "load.steps": "Lendo a fita · Ligando o console · Pronto",
    "start.press": "Aperta Start pra começar. O som liga junto.",
    "hud.pause": "Pausar",
    "hud.save": "Salvar",
    "hud.load": "Carregar",
    "hud.saves": "Saves",
    "hud.turbo": "Turbo",
    "hud.screen": "Tela",
    "hud.controls": "Controles",
    "hud.sound": "Som",
    "hud.full": "Tela cheia",
    "hud.fullAria": "Tela cheia (F ou duplo clique)",
    "hud.eject": "Ejetar",
    "hud.barLabel": "Barra do jogo",
    "hud.saveSlot": "Salvar no slot {n}",
    "hud.loadSlot": "Carregar o slot {n}",
    "hud.slotPrev": "Slot anterior",
    "hud.slotNext": "Próximo slot",
    "hud.slot": "Slot {n}",
    "hud.slotCurrent": "Slot atual",
    "hud.savesAria": "Todos os saves",
    "hud.turboAria": "Turbo, segura Espaço, T liga e desliga",
    "hud.turboPill": "Turbo {n}x",
    "hud.turboMenu": "Velocidade do turbo",
    "hud.turboAria1x": "Turbo em 1x, não acelera nada. Segura pra ajustar a velocidade",
    "hud.turboCaret": "Ajustar a velocidade do turbo",
    "hud.turboSlider": "Velocidade do turbo, de 1x a 10x",
    "hud.turboValue": "{n} vezes a velocidade normal",
    "hud.turboValueOff": "1 vez, a velocidade normal, sem turbo",
    "hud.turboPresets": "Velocidades prontas",
    "hud.turboMute": "Sem som no turbo acima de {n}x",
    "hud.mute": "Silenciar o som",
    "hud.unmute": "Ligar o som",
    "hud.exit": "Sair",
    "hud.ejectAria": "Ejetar a fita e voltar pra prateleira",
    "hud.resume": "Continuar",
    "hud.played": "{time} de jogo",
    "toast.turbo1x": "Turbo em 1x não acelera nada.",
    "toast.turbo1xAction": "Ajustar",
    "toast.saved": "Tri! Salvo no slot {n}.",
    "toast.loaded": "Carregado o slot {n}.",
    "toast.undo": "Desfazer",
    "paused": "Pausado",
    "saves.sram": "Save do próprio jogo guardado sozinho a cada 30 segundos e quando tu sai.",
    "saves.empty": "Escolhe esse slot e aperta F2 pra salvar aqui.",
    "saves.oldCore": "Esse save é de outra versão do console e pode não abrir.",
    "saves.title": "Saves",
    "saves.close": "Fechar saves",
    "saves.auto": "Autosave",
    "saves.slot": "Slot {n}",
    "saves.autoHint": "guardado sozinho a cada 2 min",
    "saves.autoEmpty": "Ainda não tem autosave. Ele aparece depois de uns 2 minutos de jogo.",
    "saves.saveHere": "Salvar aqui",
    "saves.loadAria": "Carregar {name}",
    "saves.saveAria": "Salvar em {name}",
    "saves.more": "Mais opções de {name}",
    "saves.delete": "Apagar",
    "saves.originLocal": "neste aparelho",
    "saves.originPhone": "do celular",
    "saves.tryAnyway": "Tentar mesmo",
    "saves.autoSwitch": "Autosave a cada 2 min",
    "saves.sramAt": "Último: {ago}",
    "saves.emptyThumb": "vazio",
    "saves.usage": "Saves: {n} · {used} neste aparelho",
    "screen.pixel": "Pixel perfeito",
    "screen.fit": "Encaixar",
    "screen.tv": "Como na TV (4:3)",
    "screen.square": "Pixel quadrado",
    "screen.crt": "Filtro CRT",
    "screen.ambient": "Luz ambiente",
    "screen.bezel": "Moldura de TV",
    "screen.scaleTitle": "Escala",
    "screen.aspectTitle": "Proporção",
    "screen.pixelHint": "Maior múltiplo inteiro que cabe: {k}x",
    "screen.fitHint": "Enche a tela mantendo a proporção",
    "err.core": "Capaz que a fita tá ruim. O emulador não conseguiu ligar.",
    "err.crash": "O console travou. Teu último autosave é de há {ago}.",
    "export.title": "Exportar pra arquivo",
    "export.lead": "Salva a fita e os saves num arquivo pra tu levar pro outro aparelho. Nada sobe pra internet.",
    "export.choose": "O que vai no arquivo",
    "export.choice.saves": "Só os saves",
    "export.choice.savesHint": "O arquivo pequeno e seguro: os saves e as miniaturas, sem o jogo. {size}",
    "export.choice.all": "Fita e saves",
    "export.choice.allHint": "O arquivo grande: leva o jogo junto, então o outro aparelho já joga. {size}",
    "export.size": "Uns {size}.",
    "export.sizeNone": "Ainda não tem save.",
    "export.cloud": "Teus saves já vão pra tua conta; só a fita precisa ir no arquivo.",
    "export.noCloud": "Aqui os saves ficam só neste aparelho: o arquivo é o jeito de levar eles.",
    "export.privacy": "O arquivo fica no teu aparelho e só sai se tu levar. A fita nunca é enviada, nem pro pqp.",
    "export.save": "Salvar o arquivo",
    "export.importLead": "Tem um arquivo de outro aparelho?",
    "export.importButton": "Importar de um arquivo",
    "export.importNotFile": "Esse não é um arquivo .locadora. Pra botar uma fita, usa Botar fita.",
    "export.close": "Fechar",
    "export.empty": "Ainda não tem jogo na prateleira pra levar.",
    "export.failed": "Não deu pra gerar o arquivo. Tenta de novo.",
    "export.tooBig": "Esse arquivo passou de 64 MB. Escolhe só os saves ou leva menos jogos.",
    "export.done": "Arquivo salvo. No outro aparelho, abre a Locadora e usa Importar de um arquivo.",
    "import.title": "Importar de um arquivo",
    "import.games": "Jogos no arquivo: {n}",
    "import.saves": "Saves no arquivo: {n}",
    "import.collision": "Saves que já existem aqui com outro conteúdo: {n}. Qual fica?",
    "import.keep": "Ficam os que já tem aqui",
    "import.replace": "Troca pelos do arquivo",
    "import.apply": "Trazer",
    "import.cancel": "Cancelar",
    "import.missingFile": "Jogos sem a fita: {n}. Pra jogar, abre o arquivo do jogo de novo.",
    "import.notBundle": "Esse arquivo não é um pacote do Locadora.",
    "import.tooBig": "Esse arquivo passou de 64 MB.",
    "import.full": "Não cabe no aparelho agora. Libera espaço e tenta de novo.",
    "import.done": "Pronto. Jogos trazidos pra tua prateleira: {n}.",
    "import.failed": "Não deu pra trazer tudo. Tenta de novo.",
    "sync.continue": "Tu parou no {device} há {ago}. Bora continuar daqui?",
    "sync.conflict": "Tem dois saves diferentes desse slot. Qual fica?",
    "sync.both": "Guardar os dois",
    "sync.device.computer": "computador",
    "sync.device.phone": "celular",
    "sync.device.tablet": "tablet",
    "sync.from.computer": "do computador",
    "sync.from.phone": "do celular",
    "sync.from.tablet": "do tablet",
    "sync.this.computer": "deste computador",
    "sync.this.phone": "deste celular",
    "sync.this.tablet": "deste tablet",
    "sync.useRemote": "Usar o {from}",
    "sync.useLocal": "Usar o {this}",
    "sync.later": "Decidir depois",
    "sync.bothFull": "Não tem slot vazio pra guardar os dois.",
    "sync.conflictSram": "O save do próprio jogo tá diferente aqui e na tua conta. Qual fica?",
    "sync.side": "{where} · salvo há {ago}",
    "sync.go": "Bora, continuar daqui",
    "sync.keepLocal": "Continuar o deste aparelho",
    "sync.chip": "Na tua conta",
    "sync.chipBusy": "Subindo pra conta",
    "sync.chipError": "Conta sem resposta",
    "sync.chipReadOnly": "Na conta, só leitura",
    "sync.note": "Esses saves, e uma fotinho de cada, também ficam na tua conta do pqp, pra tu continuar em outro aparelho. O jogo nunca sai daqui.",
    "sync.noteReadOnly": "Saves na conta foi desligado aqui. O que já tava na tua conta ainda chega neste aparelho por 30 dias.",
    "sync.usage": "Na conta: {used} de {cap}",
    "sync.clear": "Apagar tudo da conta",
    "sync.clearAsk": "Apagar todos os saves da Locadora da tua conta? Os deste aparelho ficam.",
    "sync.clearYes": "Apagar",
    "sync.clearNo": "Cancelar",
    "sync.cleared": "Pronto, a conta tá limpa. Os saves deste aparelho ficaram.",
    "sync.clearFailed": "Não deu pra apagar agora. Tenta de novo.",
    "sync.chipNoStore": "Sem conta neste navegador",
    "sync.noteUnreachable": "Saves na conta tá ligado, mas a conta não respondeu. Teus saves ficam neste aparelho. Na prateleira dá pra tentar de novo.",
    "sync.noteNoStore": "Este navegador não guarda nada entre uma visita e outra, então os saves não sobem pra conta.",
    "sync.retry": "Tentar de novo",
    "sync.retrying": "Chamando a conta...",
    "sync.back": "A conta respondeu. Teus saves vão pra ela de novo.",
    "sync.stillDown": "A conta ainda não respondeu. Teus saves ficam neste aparelho.",
    "sync.badge": "na conta",
    "sync.shelfChip": "Saves na conta",
    "rules.sync": "Saves na conta: teus saves, e uma fotinho de cada, vão também pra tua conta do pqp. O jogo nunca vai.",
    "rules.guest": "Sem conta: tuas fitas e teus saves ficam só neste navegador.",
    "ended.synced": "A sessão acabou. Teus saves ficaram guardados neste aparelho e na tua conta.",
    "gaveta.attest": "Essa fita é minha e eu tenho direito de jogar.",
    "onb.1.sub": "Bah, bem-vindo!",
    "onb.2.title": "Pega o controle e bota a primeira fita",
    "onb.2.sub": "Controle e primeira fita",
    "onb.3.sub": "Teclado ou gamepad",
    "onb.4.body": "Escolhe o arquivo do jogo no teu computador. Ele fica só neste aparelho.",
    "onb.open": "ABERTO",
    "onb.once": "Isso aparece só na primeira vez. Dá pra rever quando quiser, no botão Ver a recepção de novo, lá no alto do Balcão.",
    "onb.steps": "Passos",
    "onb.step": "Passo {n} de {total}",
    "onb.back": "Voltar",
    "onb.close": "Fechar",
    "onb.cancel": "Cancelar",
    "onb.reset": "Voltar ao padrão",
    "onb.tabs": "Console",
    "onb.map": "Mapa do controle",
    "remap.swap": "Trocar",
    "remap.keep": "Deixa como tá",
    "pad.dpad": "Direcional",
    "pad.arrows": "Setas",
    "pad.button": "Botão {button}",
    "pad.change": "{what}: {key}. Trocar tecla",
    "pad.listening": "aperta uma tecla",
    "pad.up": "Cima",
    "pad.down": "Abaixo",
    "pad.left": "Esquerda",
    "pad.right": "Direita",
    /* the balcao (L6) */
    "rules.stamp": "Aprovado",
    "shelf.filter": "Filtrar por console",
    "shelf.filter.all": "Tudo",
    "shelf.sort": "Ordem",
    "shelf.sort.recent": "jogado por último",
    "shelf.sort.name": "nome",
    "shelf.sort.console": "console",
    "shelf.pickAnother": "Botar outra fita",
    "shelf.hint": "Setas andam pela prateleira · Enter joga · Del tira da prateleira · N bota fita",
    "box.new": "novo",
    "box.saves.one": "{n} save",
    "box.saves.other": "{n} saves",
    "box.missing": "falta a fita",
    "attach.mismatch": "Essa não é a fita dessa caixa. Abre o mesmo arquivo de antes.",
    "ficha.selected": "Selecionada",
    "ficha.play": "Jogar",
    "ficha.rename": "Renomear",
    "ficha.remove": "Tirar da prateleira",
    "ficha.remove.yes": "Tirar",
    "ficha.remove.no": "Deixar aí",
    "ficha.never": "nunca jogada",
    "ficha.played": "jogada há {ago}",
    "ficha.playtime": "{time} de jogo",
    "name.save": "Guardar",
    "name.skip": "Pular",
    "continue.badge": "Autosave · {ago}",
    "continue.savedNow": "salvo sozinho agora há pouco",
    "continue.badgeNow": "Autosave · agora",
    "ficha.playedNow": "jogada agora há pouco",
    "err.crashNow": "O console travou. Teu último autosave é de agora há pouco.",
    "top.usageEmpty": "Nada guardado ainda",
    "top.usageShort": "{used} de {cap}",
    "onb.replay": "Ver a recepção de novo",
    "hud.more": "Mais",
    "hud.moreAria": "Mais opções do jogo",
    "start.btn": "Start",
    "continue.prompt": "Continuar de onde parou?",
    "continue.fresh": "Começar do zero",
    "err.retry": "Tentar de novo",
    "err.back": "Voltar pra prateleira",
    "err.storage": "Não coube. Tira umas fitas da prateleira.",
    "err.openShelf": "Abrir prateleira",
    "err.badState": "Esse save não abriu. O jogo continua de onde tava.",
    "load.aria": "Carregando a fita",
    "load.back": "Voltar",
    "load.backAria": "Voltar pra prateleira sem jogar",
    "toast.loadedAuto": "Carregado o autosave.",
    "err.saveFailed": "Não deu pra guardar esse save. Tenta de novo.",
    "err.crashNoSave": "O console travou.",
    "err.crashLoad": "Carregar autosave",
  },
  en: {
    title: "Locadora",
    connecting: "Connecting...",
    online: "Connected",
    reconnecting: "Reconnecting...",
    outside: "Open Locadora inside pqp.",
    ended: "The session ended. Your saves are kept on this device.",
    intro:
      "This is only an emulator. pqp does not provide any game. Pick a game file on your computer and it runs right here.",
    privacy:
      "The file stays on this device. It is never sent, not to pqp and not anywhere else.",
    rights: "Only open a game you have the right to play, like one you bought or a homebrew.",
    systems: "It runs NES, SNES, Game Boy, Game Boy Color and Game Boy Advance files (.nes, .sfc, .smc, .gb, .gbc, .gba).",
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
      "Third-party software Locadora uses, with each one's license and a link to its source code. The artwork was generated with Google Gemini (Nano Banana 2.1) from our own prompts.",
    noticesLoading: "Loading the licenses...",
    noticesFailed: "The licenses could not be loaded. Try again.",
    share: "Share",
    shareStop: "Stop sharing",
    sharing: "The Locadora screen is being shared. People who come to watch see what you see here.",
    shareRefused: "Sharing is off here.",
    shareFailed: "Sharing did not work right now. Try again.",
    watchingTitle: "You are watching",
    watchingLine: "You are seeing the game screen of {names}.",
    watchingMore: " and {n} more",
    watchingEmpty: "Nobody is playing yet.",
    watchingHow: "Each game runs on the player's own computer. pqp only passes the picture along.",
    controlDpad: "Arrow keys: directional pad",
    controlA: "Z: A button",
    controlB: "X: B button",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q and E: L and R (SNES and Game Boy Advance)",
    controlGamepad: "A connected controller (gamepad) is picked up on its own.",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    problemUnsupported: "That cartridge does not fit this console.",
    problemTooBig: "That cartridge is too big for these consoles.",
    problemInvalid: "That file is not a cartridge the console can read.",
    problemLoad: "The emulator could not start.",
    problemUnsupportedHint: "It takes .nes, .sfc, .smc, .gb, .gbc, .gba.",
    problemTooBigHint: "Insert another one: Locadora plays .nes, .sfc, .smc, .gb, .gbc and .gba.",
    problemInvalidHint: "Insert another one: Locadora plays .nes, .sfc, .smc, .gb, .gbc and .gba.",
    problemLoadHint: "Try again, or insert another cartridge.",
    problemDismiss: "Close the notice",
    frameTitle: "Emulator",
    "sign.sub": "your own shelf",
    "top.pick": "Insert a cartridge",
    "top.usage": "On this device: {used} of {cap}",
    "continue.eyebrow": "Pick up where you left off",
    "continue.saved": "autosaved {ago} ago",
    "continue.go": "Continue",
    "continue.pick": "Choose a save",
    "rules.title": "House rules",
    "rules.1": "We do not rent or provide any game. The shelf only holds what you bring.",
    "rules.3": "Only insert a game you have the right to play, like one you bought or a homebrew.",
    "shelf.title": "Your shelf",
    "shelf.empty": "Empty shelf. Insert your first cartridge.",
    "shelf.noStorage": "This browser does not let us keep cartridges. You can play, but they are gone when you leave.",
    "shelf.full": "Almost full. Remove a few cartridges to make room.",
    "shelf.remove.confirm": "The cartridge and its saves are removed from this device.",
    "name.ask": "What is this cartridge called?",
    "name.default": "Untitled cartridge {n}",
    "onb.1.title": "Come in, make yourself at home",
    "onb.3.title": "Grab the controller",
    "onb.3.body": "This is the controller map. Click a button to change its key. Got a gamepad? Press any button on it.",
    "onb.pad.found": "Gamepad found! It already works.",
    "onb.listen": "Press the key for {button}...",
    "onb.4.title": "Insert your first cartridge",
    "onb.next": "Next",
    "onb.skip": "Skip all",
    "remap.reserved": "That key belongs to Locadora's shortcuts.",
    "remap.dup": "{key} is already {button}. Swap?",
    "load.steps": "Reading the cartridge · Powering on · Ready",
    "start.press": "Press Start to begin. Sound comes on with it.",
    "hud.pause": "Pause",
    "hud.save": "Save",
    "hud.load": "Load",
    "hud.saves": "Saves",
    "hud.turbo": "Turbo",
    "hud.screen": "Screen",
    "hud.controls": "Controls",
    "hud.sound": "Sound",
    "hud.full": "Fullscreen",
    "hud.fullAria": "Fullscreen (F or double-click)",
    "hud.eject": "Eject",
    "hud.barLabel": "Game bar",
    "hud.saveSlot": "Save to slot {n}",
    "hud.loadSlot": "Load slot {n}",
    "hud.slotPrev": "Previous slot",
    "hud.slotNext": "Next slot",
    "hud.slot": "Slot {n}",
    "hud.slotCurrent": "Current slot",
    "hud.savesAria": "All saves",
    "hud.turboAria": "Turbo, hold Space, T switches it on and off",
    "hud.turboPill": "Turbo {n}x",
    "hud.turboMenu": "Turbo speed",
    "hud.turboAria1x": "Turbo at 1x does nothing. Hold to adjust the speed",
    "hud.turboCaret": "Adjust the turbo speed",
    "hud.turboSlider": "Turbo speed, from 1x to 10x",
    "hud.turboValue": "{n} times normal speed",
    "hud.turboValueOff": "1 time, normal speed, no turbo",
    "hud.turboPresets": "Quick speeds",
    "hud.turboMute": "No sound in turbo above {n}x",
    "hud.mute": "Mute the sound",
    "hud.unmute": "Turn the sound on",
    "hud.exit": "Exit",
    "hud.ejectAria": "Eject the cartridge and go back to the shelf",
    "hud.resume": "Resume",
    "hud.played": "{time} played",
    "toast.turbo1x": "Turbo at 1x does not speed anything up.",
    "toast.turbo1xAction": "Adjust",
    "toast.saved": "Saved to slot {n}.",
    "toast.loaded": "Loaded slot {n}.",
    "toast.undo": "Undo",
    "paused": "Paused",
    "saves.sram": "The game's own save is kept every 30 seconds and when you leave.",
    "saves.empty": "Pick this slot and press F2 to save here.",
    "saves.oldCore": "This save is from another console version and may not open.",
    "saves.title": "Saves",
    "saves.close": "Close saves",
    "saves.auto": "Autosave",
    "saves.slot": "Slot {n}",
    "saves.autoHint": "kept automatically every 2 min",
    "saves.autoEmpty": "No autosave yet. It shows up after about 2 minutes of play.",
    "saves.saveHere": "Save here",
    "saves.loadAria": "Load {name}",
    "saves.saveAria": "Save to {name}",
    "saves.more": "More options for {name}",
    "saves.delete": "Delete",
    "saves.originLocal": "on this device",
    "saves.originPhone": "from your phone",
    "saves.tryAnyway": "Try anyway",
    "saves.autoSwitch": "Autosave every 2 min",
    "saves.sramAt": "Last: {ago}",
    "saves.emptyThumb": "empty",
    "saves.usage": "Saves: {n} · {used} on this device",
    "screen.pixel": "Pixel perfect",
    "screen.fit": "Fit",
    "screen.tv": "Like a TV (4:3)",
    "screen.square": "Square pixels",
    "screen.crt": "CRT filter",
    "screen.ambient": "Ambient light",
    "screen.bezel": "TV bezel",
    "screen.scaleTitle": "Scale",
    "screen.aspectTitle": "Aspect",
    "screen.pixelHint": "Largest whole multiple that fits: {k}x",
    "screen.fitHint": "Fills the screen and keeps the proportion",
    "err.core": "The cartridge may be bad. The emulator could not start.",
    "err.crash": "The console froze. Your last autosave is from {ago} ago.",
    "export.title": "Export to a file",
    "export.lead": "Saves the cartridge and your saves in one file you can carry to your other device. Nothing goes online.",
    "export.choose": "What goes in the file",
    "export.choice.saves": "Saves only",
    "export.choice.savesHint": "The small, safe file: your saves and their pictures, without the game. {size}",
    "export.choice.all": "Cartridge and saves",
    "export.choice.allHint": "The big file: the game goes along, so the other device can play right away. {size}",
    "export.size": "About {size}.",
    "export.sizeNone": "No saves yet.",
    "export.cloud": "Your saves already go to your account; only the cartridge needs to go in the file.",
    "export.noCloud": "Here your saves stay on this device only: the file is how you carry them.",
    "export.privacy": "The file stays on your device and only leaves if you carry it. The cartridge is never sent, not even to pqp.",
    "export.save": "Save the file",
    "export.importLead": "Got a file from another device?",
    "export.importButton": "Import from a file",
    "export.importNotFile": "That is not a .locadora file. To put a cartridge in, use Insert a cartridge.",
    "export.close": "Close",
    "export.empty": "There is no game on the shelf to take yet.",
    "export.failed": "The file did not come out. Try again.",
    "export.tooBig": "This file is over 64 MB. Choose saves only or take fewer games.",
    "export.done": "File saved. On the other device, open Locadora and use Import from a file.",
    "import.title": "Import from a file",
    "import.games": "Games in the file: {n}",
    "import.saves": "Saves in the file: {n}",
    "import.collision": "Saves already here with different content: {n}. Which stays?",
    "import.keep": "Keep what is here",
    "import.replace": "Use the file's",
    "import.apply": "Bring it",
    "import.cancel": "Cancel",
    "import.missingFile": "Games without the cartridge: {n}. To play, open the game file again.",
    "import.notBundle": "This is not a Locadora bundle.",
    "import.tooBig": "This file is over 64 MB.",
    "import.full": "It does not fit on this device now. Make some room and try again.",
    "import.done": "Done. Games brought to your shelf: {n}.",
    "import.failed": "Not everything came over. Try again.",
    "sync.continue": "You stopped on {device} {ago} ago. Continue here?",
    "sync.conflict": "There are two different saves for this slot. Which one stays?",
    "sync.both": "Keep both",
    "sync.device.computer": "the computer",
    "sync.device.phone": "the phone",
    "sync.device.tablet": "the tablet",
    "sync.from.computer": "from the computer",
    "sync.from.phone": "from the phone",
    "sync.from.tablet": "from the tablet",
    "sync.this.computer": "from this computer",
    "sync.this.phone": "from this phone",
    "sync.this.tablet": "from this tablet",
    "sync.useRemote": "Use the one {from}",
    "sync.useLocal": "Use the one {this}",
    "sync.later": "Decide later",
    "sync.bothFull": "There is no empty slot to keep both.",
    "sync.conflictSram": "The game's own save is different here and on your account. Which one stays?",
    "sync.side": "{where} · saved {ago} ago",
    "sync.go": "Yes, continue here",
    "sync.keepLocal": "Continue this device's",
    "sync.chip": "On your account",
    "sync.chipBusy": "Saving to your account",
    "sync.chipError": "Account not answering",
    "sync.chipReadOnly": "On your account, read only",
    "sync.note": "These saves, and a small picture of each, are also kept on your pqp account so you can carry on on another device. The game never leaves this device.",
    "sync.noteReadOnly": "Saves on your account was switched off here. What is already on your account still reaches this device for 30 days.",
    "sync.usage": "On your account: {used} of {cap}",
    "sync.clear": "Delete everything from my account",
    "sync.clearAsk": "Delete every Locadora save from your account? The ones on this device stay.",
    "sync.clearYes": "Delete",
    "sync.clearNo": "Cancel",
    "sync.cleared": "Done, your account is clear. The saves on this device stay.",
    "sync.clearFailed": "Could not delete it right now. Try again.",
    "sync.chipNoStore": "No account in this browser",
    "sync.noteUnreachable": "Saves on your account is on, but the account did not answer. Your saves stay on this device. You can try again from the shelf.",
    "sync.noteNoStore": "This browser keeps nothing between visits, so saves are not sent to your account.",
    "sync.retry": "Try again",
    "sync.retrying": "Calling the account...",
    "sync.back": "The account answered. Your saves go to it again.",
    "sync.stillDown": "The account still did not answer. Your saves stay on this device.",
    "sync.badge": "on your account",
    "sync.shelfChip": "Saves on your account",
    "rules.sync": "Saves on your account: your saves, and a small picture of each, also go to your pqp account. The game never does.",
    "rules.guest": "No account: your cartridges and saves stay in this browser only.",
    "ended.synced": "The session ended. Your saves are kept on this device and on your account.",
    "gaveta.attest": "This cartridge is mine and I have the right to play it.",
    "onb.1.sub": "Welcome!",
    "onb.2.title": "Grab the controller, insert your first cartridge",
    "onb.2.sub": "Controller and first cartridge",
    "onb.3.sub": "Keyboard or gamepad",
    "onb.4.body": "Pick the game file on your computer. It stays on this device only.",
    "onb.open": "OPEN",
    "onb.once": "This only shows the first time. You can see it again any time, with the button See the welcome again at the top of the shelf.",
    "onb.steps": "Steps",
    "onb.step": "Step {n} of {total}",
    "onb.back": "Back",
    "onb.close": "Close",
    "onb.cancel": "Cancel",
    "onb.reset": "Back to default",
    "onb.tabs": "Console",
    "onb.map": "Controller map",
    "remap.swap": "Swap",
    "remap.keep": "Leave it",
    "pad.dpad": "D-pad",
    "pad.arrows": "Arrows",
    "pad.button": "Button {button}",
    "pad.change": "{what}: {key}. Change key",
    "pad.listening": "press a key",
    "pad.up": "Up",
    "pad.down": "Down",
    "pad.left": "Left",
    "pad.right": "Right",
    /* the balcao (L6) */
    "rules.stamp": "Approved",
    "shelf.filter": "Filter by console",
    "shelf.filter.all": "All",
    "shelf.sort": "Sort",
    "shelf.sort.recent": "last played",
    "shelf.sort.name": "name",
    "shelf.sort.console": "console",
    "shelf.pickAnother": "Insert another cartridge",
    "shelf.hint": "Arrows move along the shelf · Enter plays · Del removes · N inserts a cartridge",
    "box.new": "new",
    "box.saves.one": "{n} save",
    "box.saves.other": "{n} saves",
    "box.missing": "missing cartridge",
    "attach.mismatch": "That is not this box's file. Open the same file as before.",
    "ficha.selected": "Selected",
    "ficha.play": "Play",
    "ficha.rename": "Rename",
    "ficha.remove": "Remove from shelf",
    "ficha.remove.yes": "Remove",
    "ficha.remove.no": "Keep it",
    "ficha.never": "never played",
    "ficha.played": "played {ago} ago",
    "ficha.playtime": "{time} played",
    "name.save": "Save",
    "name.skip": "Skip",
    "continue.badge": "Autosave · {ago}",
    "continue.savedNow": "autosaved just now",
    "continue.badgeNow": "Autosave · just now",
    "ficha.playedNow": "played just now",
    "err.crashNow": "The console froze. Your last autosave is from just now.",
    "top.usageEmpty": "Nothing kept yet",
    "top.usageShort": "{used} of {cap}",
    "onb.replay": "See the welcome again",
    "hud.more": "More",
    "hud.moreAria": "More game options",
    "start.btn": "Start",
    "continue.prompt": "Pick up where you left off?",
    "continue.fresh": "Start over",
    "err.retry": "Try again",
    "err.back": "Back to the shelf",
    "err.storage": "It did not fit. Remove a few cartridges from the shelf.",
    "err.openShelf": "Open the shelf",
    "err.badState": "That save did not open. The game goes on where it was.",
    "load.aria": "Loading the cartridge",
    "load.back": "Back",
    "load.backAria": "Back to the shelf without playing",
    "toast.loadedAuto": "Loaded the autosave.",
    "err.saveFailed": "Could not keep that save. Try again.",
    "err.crashNoSave": "The console froze.",
    "err.crashLoad": "Load the autosave",
  },
  es: {
    title: "Locadora",
    connecting: "Conectando...",
    online: "Conectado",
    reconnecting: "Reconectando...",
    outside: "Abre Locadora dentro de pqp.",
    ended: "La sesión terminó. Tus partidas guardadas se quedan en este dispositivo.",
    intro:
      "Esto es solo un emulador. pqp no proporciona ningún juego. Elige el archivo de un juego en tu computadora y corre aquí mismo.",
    privacy:
      "El archivo se queda en este dispositivo. Nunca se envía, ni a pqp ni a ningún lado.",
    rights: "Abre solo un juego que tengas derecho a jugar, como uno que compraste o un homebrew.",
    systems: "Corre archivos de NES, SNES, Game Boy, Game Boy Color y Game Boy Advance (.nes, .sfc, .smc, .gb, .gbc, .gba).",
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
      "Software de terceros que usa Locadora, con la licencia de cada uno y el enlace a su código fuente. Las ilustraciones se generaron con Google Gemini (Nano Banana 2.1) a partir de prompts nuestros.",
    noticesLoading: "Cargando las licencias...",
    noticesFailed: "No se pudieron cargar las licencias. Prueba otra vez.",
    share: "Compartir",
    shareStop: "Dejar de compartir",
    sharing: "La pantalla de Locadora se está compartiendo. Quien entre a mirar ve lo que tú ves aquí.",
    shareRefused: "Compartir está desactivado aquí.",
    shareFailed: "No se pudo compartir ahora. Prueba otra vez.",
    watchingTitle: "Estás mirando",
    watchingLine: "Ves la pantalla del juego de {names}.",
    watchingMore: " y {n} más",
    watchingEmpty: "Todavía no juega nadie.",
    watchingHow: "Cada juego corre en la computadora de quien juega. pqp solo pasa la imagen.",
    controlDpad: "Flechas: cruceta",
    controlA: "Z: botón A",
    controlB: "X: botón B",
    controlStart: "Enter: Start",
    controlSelect: "V: Select",
    controlShoulders: "Q y E: L y R (SNES y Game Boy Advance)",
    controlGamepad: "Un control (gamepad) conectado se reconoce solo.",
    fullscreen: "Pantalla completa",
    exitFullscreen: "Salir de pantalla completa",
    problemUnsupported: "Ese archivo no se puede abrir.",
    problemTooBig: "Ese archivo es demasiado grande para estas consolas.",
    problemInvalid: "Ese archivo no es un cartucho que la consola pueda leer.",
    problemLoad: "El emulador no pudo iniciar.",
    problemUnsupportedHint: "Elige un .nes, .sfc, .smc, .gb, .gbc o .gba.",
    problemTooBigHint: "Pon otro: Locadora juega .nes, .sfc, .smc, .gb, .gbc y .gba.",
    problemInvalidHint: "Pon otro: Locadora juega .nes, .sfc, .smc, .gb, .gbc y .gba.",
    problemLoadHint: "Prueba otra vez o pon otro cartucho.",
    problemDismiss: "Cerrar el aviso",
    frameTitle: "Emulador",
    "sign.sub": "la estantería es tuya",
    "top.pick": "Poner cartucho",
    "top.usage": "En este dispositivo: {used} de {cap}",
    "continue.eyebrow": "Seguir donde lo dejaste",
    "continue.saved": "autoguardado hace {ago}",
    "continue.go": "Continuar",
    "continue.pick": "Elegir partida",
    "rules.title": "Reglas de la casa",
    "rules.1": "No alquilamos ni proporcionamos ningún juego. La estantería solo guarda los cartuchos que traigas.",
    "rules.3": "Pon solo juegos que tengas derecho a jugar: uno que compraste o un homebrew.",
    "shelf.title": "Tu estantería",
    "shelf.empty": "Estantería vacía. Pon tu primer cartucho.",
    "shelf.noStorage": "Este navegador no deja guardar los cartuchos. Puedes jugar, pero desaparecen cuando salgas.",
    "shelf.full": "Casi llena. Quita algunos cartuchos de la estantería para que quepan más.",
    "shelf.remove.confirm": "El cartucho y sus partidas guardadas desaparecen de este dispositivo.",
    "name.ask": "¿Cómo se llama este cartucho?",
    "name.default": "Cartucho sin nombre {n}",
    "onb.1.title": "Pasa, la casa es tuya",
    "onb.3.title": "Agarra el control",
    "onb.3.body": "Este es el mapa del control. Haz clic en un botón para cambiar su tecla. Si tienes un gamepad, solo aprieta cualquier botón.",
    "onb.pad.found": "¡Encontré un gamepad! Ya funciona.",
    "onb.listen": "Pulsa la tecla para el botón {button}...",
    "onb.4.title": "Pon tu primer cartucho",
    "onb.next": "Dale, siguiente",
    "onb.skip": "Saltar todo",
    "remap.reserved": "Esa tecla es de los atajos de Locadora.",
    "remap.dup": "{key} ya es el botón {button}. ¿Intercambiar?",
    "load.steps": "Leyendo el cartucho · Encendiendo la consola · Listo",
    "start.press": "Pulsa Start para empezar. El sonido se activa con eso.",
    "hud.pause": "Pausar",
    "hud.save": "Guardar",
    "hud.load": "Cargar",
    "hud.saves": "Partidas",
    "hud.turbo": "Turbo",
    "hud.screen": "Pantalla",
    "hud.controls": "Controles",
    "hud.sound": "Sonido",
    "hud.full": "Pantalla completa",
    "hud.fullAria": "Pantalla completa (F o doble clic)",
    "hud.eject": "Expulsar",
    "hud.barLabel": "Barra del juego",
    "hud.saveSlot": "Guardar en el slot {n}",
    "hud.loadSlot": "Cargar el slot {n}",
    "hud.slotPrev": "Slot anterior",
    "hud.slotNext": "Siguiente slot",
    "hud.slot": "Slot {n}",
    "hud.slotCurrent": "Slot actual",
    "hud.savesAria": "Todas las partidas guardadas",
    "hud.turboAria": "Turbo, mantén Espacio, T lo activa y lo desactiva",
    "hud.turboPill": "Turbo {n}x",
    "hud.turboMenu": "Velocidad del turbo",
    "hud.turboAria1x": "Turbo a 1x no acelera nada. Mantén pulsado para ajustar la velocidad",
    "hud.turboCaret": "Ajustar la velocidad del turbo",
    "hud.turboSlider": "Velocidad del turbo, de 1x a 10x",
    "hud.turboValue": "{n} veces la velocidad normal",
    "hud.turboValueOff": "1 vez, la velocidad normal, sin turbo",
    "hud.turboPresets": "Velocidades rápidas",
    "hud.turboMute": "Sin sonido en turbo por encima de {n}x",
    "hud.mute": "Silenciar el sonido",
    "hud.unmute": "Activar el sonido",
    "hud.exit": "Salir",
    "hud.ejectAria": "Expulsar el cartucho y volver a la estantería",
    "hud.resume": "Continuar",
    "hud.played": "{time} de juego",
    "toast.turbo1x": "El turbo a 1x no acelera nada.",
    "toast.turbo1xAction": "Ajustar",
    "toast.saved": "¡Listo! Guardado en el slot {n}.",
    "toast.loaded": "Slot {n} cargado.",
    "toast.undo": "Deshacer",
    "paused": "En pausa",
    "saves.sram": "El guardado del propio juego se guarda solo cada 30 segundos y cuando sales.",
    "saves.empty": "Elige este slot y pulsa F2 para guardar aquí.",
    "saves.oldCore": "Esta partida es de otra versión de la consola y puede no abrir.",
    "saves.title": "Guardados",
    "saves.close": "Cerrar guardados",
    "saves.auto": "Autoguardado",
    "saves.slot": "Ranura {n}",
    "saves.autoHint": "guardado solo cada 2 min",
    "saves.autoEmpty": "Todavía no hay autoguardado. Aparece después de unos 2 minutos de juego.",
    "saves.saveHere": "Guardar aquí",
    "saves.loadAria": "Cargar {name}",
    "saves.saveAria": "Guardar en {name}",
    "saves.more": "Más opciones de {name}",
    "saves.delete": "Borrar",
    "saves.originLocal": "en este dispositivo",
    "saves.originPhone": "del celular",
    "saves.tryAnyway": "Intentar igual",
    "saves.autoSwitch": "Autoguardado cada 2 min",
    "saves.sramAt": "Último: {ago}",
    "saves.emptyThumb": "vacío",
    "saves.usage": "Guardados: {n} · {used} en este dispositivo",
    "screen.pixel": "Pixel perfecto",
    "screen.fit": "Ajustar",
    "screen.tv": "Como en la TV (4:3)",
    "screen.square": "Píxel cuadrado",
    "screen.crt": "Filtro CRT",
    "screen.ambient": "Luz ambiente",
    "screen.bezel": "Marco de TV",
    "screen.scaleTitle": "Escala",
    "screen.aspectTitle": "Proporción",
    "screen.pixelHint": "El mayor múltiplo entero que cabe: {k}x",
    "screen.fitHint": "Llena la pantalla manteniendo la proporción",
    "err.core": "Puede que el cartucho esté dañado. El emulador no pudo encender.",
    "err.crash": "La consola se colgó. Tu último autoguardado es de hace {ago}.",
    "export.title": "Exportar a un archivo",
    "export.lead": "Guarda el cartucho y tus partidas en un archivo para llevarlo a tu otro dispositivo. Nada sube a internet.",
    "export.choose": "Qué va en el archivo",
    "export.choice.saves": "Solo las partidas",
    "export.choice.savesHint": "El archivo pequeño y seguro: tus partidas y sus miniaturas, sin el juego. {size}",
    "export.choice.all": "Cartucho y partidas",
    "export.choice.allHint": "El archivo grande: el juego va incluido, así que el otro dispositivo juega de inmediato. {size}",
    "export.size": "Unos {size}.",
    "export.sizeNone": "Todavía no hay partidas.",
    "export.cloud": "Tus partidas ya van a tu cuenta; solo el cartucho necesita ir en el archivo.",
    "export.noCloud": "Aquí tus partidas se quedan solo en este dispositivo: el archivo es la forma de llevarlas.",
    "export.privacy": "El archivo se queda en tu dispositivo y solo sale si tú lo llevas. El cartucho nunca se envía, ni a pqp.",
    "export.save": "Guardar el archivo",
    "export.importLead": "¿Tienes un archivo de otro dispositivo?",
    "export.importButton": "Importar de un archivo",
    "export.importNotFile": "Ese no es un archivo .locadora. Para poner un cartucho, usa Poner cartucho.",
    "export.close": "Cerrar",
    "export.empty": "Todavía no hay juegos en el estante para llevar.",
    "export.failed": "No se pudo generar el archivo. Inténtalo de nuevo.",
    "export.tooBig": "Este archivo pasa de 64 MB. Elige solo las partidas o lleva menos juegos.",
    "export.done": "Archivo guardado. En el otro dispositivo, abre Locadora y usa Importar de un archivo.",
    "import.title": "Importar de un archivo",
    "import.games": "Juegos en el archivo: {n}",
    "import.saves": "Guardados en el archivo: {n}",
    "import.collision": "Guardados que ya existen aquí con otro contenido: {n}. ¿Cuál se queda?",
    "import.keep": "Quedan los que ya hay aquí",
    "import.replace": "Cambiar por los del archivo",
    "import.apply": "Traer",
    "import.cancel": "Cancelar",
    "import.missingFile": "Juegos sin el cartucho: {n}. Para jugar, abre otra vez el archivo del juego.",
    "import.notBundle": "Este archivo no es un paquete de Locadora.",
    "import.tooBig": "Este archivo pasa de 64 MB.",
    "import.full": "No cabe en este dispositivo ahora. Libera espacio e inténtalo de nuevo.",
    "import.done": "Listo. Juegos traídos a tu estante: {n}.",
    "import.failed": "No se pudo traer todo. Inténtalo de nuevo.",
    "sync.continue": "Lo dejaste en {device} hace {ago}. ¿Seguimos desde aquí?",
    "sync.conflict": "Hay dos partidas distintas en este slot. ¿Cuál se queda?",
    "sync.both": "Guardar las dos",
    "sync.device.computer": "la computadora",
    "sync.device.phone": "el celular",
    "sync.device.tablet": "la tablet",
    "sync.from.computer": "de la computadora",
    "sync.from.phone": "del celular",
    "sync.from.tablet": "de la tablet",
    "sync.this.computer": "de esta computadora",
    "sync.this.phone": "de este celular",
    "sync.this.tablet": "de esta tablet",
    "sync.useRemote": "Usar la {from}",
    "sync.useLocal": "Usar la {this}",
    "sync.later": "Decidir después",
    "sync.bothFull": "No hay un slot vacío para guardar las dos.",
    "sync.conflictSram": "La partida del propio juego es distinta aquí y en tu cuenta. ¿Cuál se queda?",
    "sync.side": "{where} · guardada hace {ago}",
    "sync.go": "Sí, seguir aquí",
    "sync.keepLocal": "Seguir con la de este dispositivo",
    "sync.chip": "En tu cuenta",
    "sync.chipBusy": "Guardando en tu cuenta",
    "sync.chipError": "La cuenta no responde",
    "sync.chipReadOnly": "En tu cuenta, solo lectura",
    "sync.note": "Estas partidas, y una imagen pequeña de cada una, también se guardan en tu cuenta de pqp para seguir en otro dispositivo. El juego nunca sale de aquí.",
    "sync.noteReadOnly": "Las partidas en la cuenta se apagaron aquí. Lo que ya estaba en tu cuenta sigue llegando a este dispositivo durante 30 días.",
    "sync.usage": "En tu cuenta: {used} de {cap}",
    "sync.clear": "Borrar todo de mi cuenta",
    "sync.clearAsk": "¿Borrar todas las partidas de la Locadora de tu cuenta? Las de este dispositivo se quedan.",
    "sync.clearYes": "Borrar",
    "sync.clearNo": "Cancelar",
    "sync.cleared": "Listo, tu cuenta quedó limpia. Las partidas de este dispositivo se quedan.",
    "sync.clearFailed": "No se pudo borrar ahora. Inténtalo de nuevo.",
    "sync.chipNoStore": "Sin cuenta en este navegador",
    "sync.noteUnreachable": "Partidas en la cuenta está activado, pero la cuenta no respondió. Tus partidas se quedan en este dispositivo. Desde el estante puedes intentarlo de nuevo.",
    "sync.noteNoStore": "Este navegador no guarda nada entre visitas, así que las partidas no suben a tu cuenta.",
    "sync.retry": "Intentar de nuevo",
    "sync.retrying": "Llamando a la cuenta...",
    "sync.back": "La cuenta respondió. Tus partidas vuelven a ir a ella.",
    "sync.stillDown": "La cuenta todavía no respondió. Tus partidas se quedan en este dispositivo.",
    "sync.badge": "en la cuenta",
    "sync.shelfChip": "Partidas en la cuenta",
    "rules.sync": "Partidas en la cuenta: tus partidas, y una imagen pequeña de cada una, también van a tu cuenta de pqp. El juego nunca va.",
    "rules.guest": "Sin cuenta: tus cartuchos y tus partidas se quedan solo en este navegador.",
    "ended.synced": "La sesión terminó. Tus partidas guardadas se quedan en este dispositivo y en tu cuenta.",
    "gaveta.attest": "Este cartucho es mío y tengo derecho a jugarlo.",
    "onb.1.sub": "¡Bienvenido!",
    "onb.2.title": "Agarra el control y pon tu primer cartucho",
    "onb.2.sub": "Control y primer cartucho",
    "onb.3.sub": "Teclado o gamepad",
    "onb.4.body": "Elige el archivo del juego en tu computadora. Se queda solo en este dispositivo.",
    "onb.open": "ABIERTO",
    "onb.once": "Esto aparece solo la primera vez. Puedes verlo de nuevo cuando quieras, con el botón Ver la bienvenida otra vez, arriba en el mostrador.",
    "onb.steps": "Pasos",
    "onb.step": "Paso {n} de {total}",
    "onb.back": "Atrás",
    "onb.close": "Cerrar",
    "onb.cancel": "Cancelar",
    "onb.reset": "Restablecer",
    "onb.tabs": "Consola",
    "onb.map": "Mapa del mando",
    "remap.swap": "Intercambiar",
    "remap.keep": "Dejarlo",
    "pad.dpad": "Cruceta",
    "pad.arrows": "Flechas",
    "pad.button": "Botón {button}",
    "pad.change": "{what}: {key}. Cambiar tecla",
    "pad.listening": "pulsa una tecla",
    "pad.up": "Arriba",
    "pad.down": "Abajo",
    "pad.left": "Izquierda",
    "pad.right": "Derecha",
    /* the balcao (L6) */
    "rules.stamp": "Aprobado",
    "shelf.filter": "Filtrar por consola",
    "shelf.filter.all": "Todo",
    "shelf.sort": "Orden",
    "shelf.sort.recent": "jugado por última vez",
    "shelf.sort.name": "nombre",
    "shelf.sort.console": "consola",
    "shelf.pickAnother": "Insertar otro cartucho",
    "shelf.hint": "Las flechas recorren la estantería · Enter juega · Supr quita · N inserta un cartucho",
    "box.new": "nuevo",
    "box.saves.one": "{n} guardado",
    "box.saves.other": "{n} guardados",
    "box.missing": "falta el cartucho",
    "attach.mismatch": "Ese no es el archivo de esta caja. Abre el mismo de antes.",
    "ficha.selected": "Seleccionado",
    "ficha.play": "Jugar",
    "ficha.rename": "Renombrar",
    "ficha.remove": "Quitar de la estantería",
    "ficha.remove.yes": "Quitar",
    "ficha.remove.no": "Dejarlo",
    "ficha.never": "nunca jugado",
    "ficha.played": "jugado hace {ago}",
    "ficha.playtime": "{time} de juego",
    "name.save": "Guardar",
    "name.skip": "Omitir",
    "continue.badge": "Autoguardado · {ago}",
    "continue.savedNow": "autoguardado hace un momento",
    "continue.badgeNow": "Autoguardado · ahora",
    "ficha.playedNow": "jugado hace un momento",
    "err.crashNow": "La consola se colgó. Tu último autoguardado es de hace un momento.",
    "top.usageEmpty": "Todavía no hay nada guardado",
    "top.usageShort": "{used} de {cap}",
    "onb.replay": "Ver la bienvenida otra vez",
    "hud.more": "Más",
    "hud.moreAria": "Más opciones del juego",
    "start.btn": "Start",
    "continue.prompt": "¿Seguir donde lo dejaste?",
    "continue.fresh": "Empezar de cero",
    "err.retry": "Intentar de nuevo",
    "err.back": "Volver a la estantería",
    "err.storage": "No cupo. Quita algunos cartuchos de la estantería.",
    "err.openShelf": "Abrir la estantería",
    "err.badState": "Esa partida no abrió. El juego sigue donde estaba.",
    "load.aria": "Cargando el cartucho",
    "load.back": "Volver",
    "load.backAria": "Volver a la estantería sin jugar",
    "toast.loadedAuto": "Autoguardado cargado.",
    "err.saveFailed": "No se pudo guardar esa partida. Inténtalo de nuevo.",
    "err.crashNoSave": "La consola se colgó.",
    "err.crashLoad": "Cargar el autoguardado",
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
