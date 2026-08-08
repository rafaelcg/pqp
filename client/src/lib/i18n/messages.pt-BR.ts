/**
 * Brazilian Portuguese.
 *
 * Loaded on demand (see `loadCatalogue`), so this file is its own chunk and an
 * English visitor never downloads it — the same arrangement `main.tsx` already
 * uses for Clerk's pt-BR strings.
 *
 * Register: Brazilian, informal, the way a Discord server talks. "Você", never
 * "tu". The marketing copy is rewritten rather than translated — several English
 * lines are jokes that do not survive word-for-word, so what is kept is the job
 * the line does, not its literal content. Terms Brazilian gamers say in English
 * ("chat", "call", "self-host", "open source" where it reads as a label, "stack",
 * "app") are left alone; translating them is what makes a page read as machine
 * output.
 *
 * Only translated keys belong here. Anything omitted renders the English from
 * `catalogue.ts`, which is what makes it safe to leave a string out on purpose.
 */

import type { PartialMessages } from "./catalogue";

export const ptBR: PartialMessages = {
  // ---------------------------------------------------------------- marketing
  "nav.howItWorks": "Como funciona",
  // "Self-host" is the word Brazilian devs actually use; "auto-hospedagem"
  // exists but reads like documentation nobody wrote. Marked lang="en" at the
  // call site.
  "nav.selfHost": "Self-host",
  "nav.signIn": "Entrar",
  "nav.signUp": "Criar um servidor",
  "nav.openApp": "Abrir o app",

  "landing.seo.title": "pqp — o chat em grupo é seu",
  "landing.seo.description":
    "Chat em grupo com servidores, canais e voz que simplesmente funciona. Código aberto — hospede você mesmo ou use o pqp.gg.",
  // A piada do nome, feita uma vez e só aqui. O convite mais abaixo aponta pro
  // outro lado ("vai pra pqp") de propósito — não unifique os dois.
  "landing.hero.title": "Vem pra pqp.",
  "landing.hero.body":
    "Voz, chat e tela compartilhada pra sua galera. Cria o servidor, manda o link. Só isso.",

  "landing.trust.openSource": "Código aberto",
  "landing.trust.selfHostable": "Self-host",
  "landing.trust.meshVoice": "Voz em mesh",
  "landing.trust.inviteCodes": "Código de convite",
  "landing.trust.yourKeys": "Suas chaves",

  // "Renting the room" has no Brazilian equivalent that lands. "Morar de favor"
  // does the same job: you are only there while somebody else allows it.
  "landing.pitch.title": "Cansado de morar de favor?",
  "landing.pitch.body":
    "Os apps grandes mudam as regras quando querem, escondem os seus servidores e tratam a sua turma como estoque. O pqp é o contrário: cria um servidor, chama a galera, conversa. Fica com as chaves se quiser — ou usa as nossas e esquece a infra.",

  "landing.how.title": "Três passos. Depois é só gritar.",
  "landing.how.body": "Sem labirinto de cadastro. Cria, chama, apronta.",
  "landing.how.step1.title": "Cria um servidor",
  "landing.how.step1.body":
    "Bota um nome ridículo. Os canais de texto e de voz já vêm prontos.",
  "landing.how.step2.title": "Manda o convite",
  "landing.how.step2.body":
    "Compartilha um código. A galera entra — sem depender de loja de aplicativo.",
  "landing.how.step3.title": "Fala",
  "landing.how.step3.body":
    "Enche os canais. Cai na call quando o chat não dá conta.",

  // Nomes de recurso escritos como um dev brasileiro fala, não traduzidos ao pé
  // da letra. "Markdown", "chat", "app", "kick" e "ban" ficam em inglês porque
  // é assim que se diz — e ficam no meio da frase sem lang="en", igual ao resto
  // do catálogo, que só marca rótulos soltos.
  "landing.features.title": "O básico, bem feito.",
  "landing.features.body":
    "Nada de promessa. Tudo aqui já funciona — no navegador, no desktop ou instalado no celular.",

  "landing.features.voice.title": "Canais de voz",
  // O limite de 5 a 8 é o teto real do mesh, dito como fato e não como desculpa.
  "landing.features.voice.body":
    "Entra e fala. O áudio vai direto entre vocês — de 5 a 8 pessoas por canal.",
  "landing.features.screen.title": "Tela compartilhada",
  "landing.features.screen.body":
    "Mostra o jogo, o código ou o bug pra quem tá no canal. Uma pessoa de cada vez.",
  "landing.features.chat.title": "Chat sem firula",
  "landing.features.chat.body":
    "Markdown, resposta, reação, mensagem fixada e @menção. Colou um link, já vira preview.",
  "landing.features.search.title": "Acha o que foi dito",
  "landing.features.search.body":
    "Busca por palavra no servidor inteiro e cai direto na mensagem, com o que veio antes e depois.",
  "landing.features.dms.title": "DM e grupo",
  "landing.features.dms.body":
    "Chama alguém no privado ou monta um grupo com até 10 pessoas.",
  "landing.features.structure.title": "Servidor do seu jeito",
  "landing.features.structure.body":
    "Categorias pra organizar, canais privados e três cargos: dono, admin e membro.",
  "landing.features.invites.title": "Convite é só um link",
  "landing.features.invites.body":
    "Manda e a pessoa entra. Dá pra limitar quantos usos tem e por quanto tempo vale.",
  "landing.features.moderation.title": "Moderação de verdade",
  "landing.features.moderation.body":
    "Expulsa, bane, apaga mensagem e recebe denúncia dentro do app — tudo registrado.",

  "landing.hosting.title": "Rode você mesmo — ou não",
  "landing.hosting.body": "Mesmo produto. Você escolhe quem cuida do servidor.",
  "landing.hosting.selfHost.title": "Self-host",
  "landing.hosting.selfHost.body":
    "Clona o repositório, aponta pro Postgres, coloca as suas chaves do Clerk. Os seus dados ficam na sua máquina. Sem limite para uso open source — a stack é sua.",
  "landing.hosting.hosted.title": "Hospedado no pqp.gg",
  "landing.hosting.hosted.body":
    "Cria a conta e usa. A gente cuida dos servidores, do login e do armazenamento. Mesma bagunça, zero infra.",

  "landing.cta.title": "A sala tá vazia. Resolve isso.",
  "landing.cta.body":
    "Cria um servidor em menos de um minuto. A bagunça você chama depois.",
  // O contraponto do "vem" lá de cima: aqui a ação é mandar alguém pra algum
  // lugar, que é onde a piada funciona de novo. A seta é desenhada no JSX.
  "landing.cta.action": "Vai pra pqp",

  // ------------------------------------------------------- desktop downloads
  // "Baixar", nunca "fazer download". "Build", "app" e os nomes dos formatos
  // (AppImage, .deb, Apple Silicon, Intel) ficam como estão — é assim que se
  // diz, e traduzir nome de arquivo confunde na hora de escolher. Por isso
  // `download.mac.appleSiliconShort`, `download.mac.intelShort`,
  // `download.linux.appImage` e `download.linux.deb` não aparecem aqui: caem no
  // inglês do catálogo, que já é o texto certo.
  "download.mac.appleSilicon": "Baixar pra Mac (Apple Silicon)",
  "download.mac.intel": "Baixar pra Mac (Intel)",
  "download.mac.either": "Baixar pra Mac:",
  "download.mac.whichChip":
    "Não sabe qual? Menu Apple → Sobre este Mac. Se aparecer Apple M1 ou mais novo, é Apple Silicon.",
  "download.windows": "Baixar pra Windows",
  "download.windows.unsigned":
    "O build de Windows ainda não é assinado, então o SmartScreen avisa na primeira vez que você abrir.",
  "download.linux": "Baixar pra Linux:",
  "download.linux.appImage.full": "Baixar pra Linux (AppImage)",
  "download.linux.deb.full": "Baixar pra Linux (.deb)",
  "download.linux.unsigned": "Os builds de Linux também não são assinados.",
  "download.unsigned.help": "Por quê",
  "download.other": "Baixar pro desktop",
  "download.mobile":
    "Não tem app pra instalar aqui. Abre o pqp no navegador e adiciona na tela de início pelo menu.",

  // ------------------------------------------------------------ legal pages
  // O texto das páginas legais está em `pages/legal/*.pt-BR.tsx`, não aqui.
  // Estas duas linhas são só a moldura que o documento não controla.
  "legal.eyebrow": "Jurídico",
  "legal.updated": "Última atualização: {date}",

  "footer.tagline":
    "O chat em grupo é seu. Hospede você mesmo ou use o pqp.gg — a bagunça é a mesma.",
  "footer.product": "Produto",
  "footer.desktop": "App de desktop",
  "footer.legal": "Jurídico",
  "footer.status": "Status",
  "footer.privacy": "Privacidade",
  "footer.terms": "Termos",
  "footer.cookies": "Cookies",
  "footer.copyright":
    "© {year} pqp. Código aberto. Feito para o grupo que não cala a boca.",

  // ------------------------------------------------------- app bootstrap shell
  "app.seo.title": "App — pqp",
  "app.seo.description": "Abra o pqp — servidores, texto e voz.",
  "app.loading": "Carregando…",
  "app.loading.signingIn": "Entrando…",
  "app.loading.servers": "Carregando servidores…",

  "signedOut.title": "Entra pra conversar.",
  "signedOut.body": "Cria uma conta ou entra para abrir os seus servidores.",
  "signedOut.createAccount": "Criar conta",

  "bootstrapError.title": "Não dá para falar com a API",
  "bootstrapError.fallback": "Não foi possível carregar os servidores da API",
  "bootstrapError.deploy.1":
    "O site institucional no Cloudflare Pages é estático. O login funciona pelo Clerk, mas os servidores precisam de uma API hospedada (Railway/Docker) com",
  "bootstrapError.deploy.2": "e",
  "bootstrapError.deploy.3": "definidos no build. Veja",
  "bootstrapError.retry": "Tentar de novo",
  "bootstrapError.home": "Voltar para o início",

  // ------------------------------------------------------------- empty states
  "empty.noServers.title": "Nenhum servidor ainda",
  "empty.noServers.body": "Cria um servidor ou entra com um código de convite.",
  "empty.pickChannel.title": "Escolha um canal",
  "empty.pickChannel.body": "Abra a barra lateral e escolha texto ou voz.",
  "empty.noConversation.title": "Nenhuma conversa aberta",
  "empty.noConversation.body":
    "Escolha alguém da lista ou chame qualquer pessoa pelo nome de usuário.",
  "empty.createServer": "Criar servidor",
  "empty.joinInvite": "Entrar com convite",
  "empty.newMessage": "Nova mensagem",
  "empty.openNav": "Abrir navegação",

  "sso.title": "Liberados para você",
  "sso.body.one":
    "O seu e-mail verificado deixa você entrar neste servidor sem convite.",
  "sso.body.many":
    "O seu e-mail verificado deixa você entrar nestes servidores sem convite.",
  "sso.join": "Entrar",
  "sso.joining": "Entrando…",
  "sso.joinFailed": "Não foi possível entrar em {name}",

  // ------------------------------------------------------- connection status
  "connection.reconnecting": "Conexão perdida — reconectando…",
  "connection.unauthorized": "Sessão expirada — reconectando…",
  "connection.dismiss": "Dispensar",
  "connection.authFailed":
    "Falha na autenticação em tempo real — entre novamente",
  "connection.wsUrlFailed":
    "Falha na conexão em tempo real — verifique a URL do WebSocket",

  // ---------------------------------------------------------------- user status
  "status.online": "Online",
  "status.idle": "Ausente",
  "status.dnd": "Não perturbe",
  "status.offline": "Offline",
  "status.invisible": "Invisível",
  "status.change": "Mudar o seu status",
  "status.invisibleHint":
    "Você vai aparecer como offline para todo mundo, e não vai surgir nas listas de quem está no canal nem em “digitando…”. Canais de voz em que você entrar continuam mostrando você — lá as pessoas ouvem você.",
  "status.dndHint":
    "Você continua visível; este aparelho para de mostrar notificações.",
  "status.saveFailed": "Não foi possível mudar o seu status — tente de novo",

  // ------------------------------------------------------------------ age gate
  "ageGate.eyebrow": "Antes de começar",
  "ageGate.title": "Confirme a sua data de nascimento",
  "ageGate.description": "O pqp é para pessoas de {age} anos ou mais.",
  "ageGate.intro":
    "A gente pergunta uma vez só e não confere com nenhum documento — estamos acreditando na sua palavra. Confira antes de continuar, porque você não vai poder mudar esta resposta depois.",
  "ageGate.legend": "Data de nascimento",
  "ageGate.day": "Dia",
  "ageGate.day.placeholder": "DD",
  "ageGate.month": "Mês",
  "ageGate.year": "Ano",
  "ageGate.year.placeholder": "AAAA",
  "ageGate.warning":
    "Você só pode responder uma vez. Se a data informada for de menor de {age} anos, esta conta será encerrada e você não poderá tentar outra data.",
  "ageGate.submit": "Continuar",
  "ageGate.submitting": "Salvando…",
  "ageGate.error.badDate":
    "Não conseguimos ler esta data. Confira o dia, o mês e o ano.",
  "ageGate.error.save":
    "Não foi possível salvar. Verifique a sua conexão e tente de novo.",

  // Capitalised because they are labels in a picker, not months inside a
  // sentence — pt-BR lowercases months in running text, which this is not.
  "ageGate.month.1": "Janeiro",
  "ageGate.month.2": "Fevereiro",
  "ageGate.month.3": "Março",
  "ageGate.month.4": "Abril",
  "ageGate.month.5": "Maio",
  "ageGate.month.6": "Junho",
  "ageGate.month.7": "Julho",
  "ageGate.month.8": "Agosto",
  "ageGate.month.9": "Setembro",
  "ageGate.month.10": "Outubro",
  "ageGate.month.11": "Novembro",
  "ageGate.month.12": "Dezembro",

  "ageGate.blocked.eyebrow": "Verificação de idade",
  "ageGate.blocked.title": "O pqp é para maiores de {age} anos",
  "ageGate.blocked.body":
    "Obrigado por responder com honestidade. A data de nascimento informada é de menor de {age} anos, então esta conta foi encerrada. Isso é uma regra do serviço, não um julgamento sobre você — o pqp foi feito para adultos e não conseguimos abrir exceções.",
  "ageGate.blocked.appeal.before":
    "Se você errou a data sem querer, pode pedir para a gente revisar. O endereço para recurso — e para pedir a exclusão da conta e dos dados ligados a ela — está na nossa página de",
  "ageGate.blocked.appeal.link": "Termos",
  "ageGate.blocked.appeal.after": ".",
  "ageGate.blocked.wait":
    "Por favor, não abra outra conta enquanto isso — preferimos resolver esta aqui.",
  "ageGate.blocked.back": "Voltar para o pqp.gg",

  // ------------------------------------------------------ first-run onboarding
  // Registro: o mesmo da landing — informal, frases curtas, sem ponto de
  // exclamação. O age gate acima fala "você, confira" porque é uma declaração
  // com consequência; aqui não é, então volta pro "cria, bota, cola" do resto
  // do produto. Nada de "passo 1 de 3" nem "tudo pronto".
  //
  // "Handle" não tem tradução que cole. No Brasil é "o seu @", e é assim que
  // aparece — a palavra "handle" traduzida ao pé da letra é o que faz o texto
  // parecer saída de máquina.
  // A tela do confete. O confete comemora; o texto fica seco de propósito —
  // "Agora a burocracia" em cima de papel picado cai muito melhor do que
  // qualquer "eba, você chegou", e é um campo só, o que é a piada.
  "onboarding.handle.eyebrow": "Tá dentro",
  "onboarding.handle.title": "Agora a burocracia",
  "onboarding.handle.description":
    "Um campo. Esse é o nome que a galera digita pra te achar — a gente tirou da sua conta, e o número é seu.",
  "onboarding.handle.label": "Nome de usuário",
  "onboarding.handle.hint":
    "Só minúscula, número e _. O número no fim vem de brinde.",
  "onboarding.handle.confirm": "Tá certo",
  "onboarding.handle.reassigned": "Esse já tinha dono. Você ficou com {tag}.",
  "onboarding.handle.error.taken":
    "Esse nome lotou — não sobrou número nenhum. Escolhe outro.",
  "onboarding.handle.error.invalid":
    "Só minúscula, número e _, de 2 a 32 caracteres.",
  "onboarding.handle.error.generic": "Não deu pra salvar. Tenta de novo.",

  "onboarding.profile.eyebrow": "Sua cara",
  "onboarding.profile.title": "Agora a parte que aparece",
  "onboarding.profile.description":
    "O @ é pra te acharem. Isso aqui é como te veem.",
  "onboarding.profile.displayName": "Nome de exibição",
  "onboarding.profile.displayNamePlaceholder": "Como te chamam",
  "onboarding.profile.avatar": "Avatar",
  "onboarding.profile.avatarUrl": "URL da imagem do avatar",
  "onboarding.profile.avatarUrlPlaceholder": "https://… URL da imagem",
  "onboarding.profile.avatarPreset": "Usar este avatar",
  "onboarding.profile.avatarClear": "Limpar",
  "onboarding.profile.error": "Não deu pra salvar. Tenta de novo.",

  "onboarding.landing.eyebrow": "Última coisa",
  "onboarding.landing.title": "Ainda não tem ninguém aqui",
  "onboarding.landing.description":
    "Cria um servidor e manda o link, ou cola o link que te mandaram.",
  "onboarding.landing.createLabel": "Cria um servidor",
  "onboarding.landing.createPlaceholder": "Bota um nome ridículo",
  "onboarding.landing.createAction": "Criar",
  "onboarding.landing.createHint":
    "Os canais de texto e de voz já vêm prontos. Chama a galera quando quiser.",
  "onboarding.landing.joinLabel": "Ou usa um convite",
  "onboarding.landing.joinPlaceholder": "Código ou link do convite",
  "onboarding.landing.joinAction": "Entrar",
  "onboarding.landing.createError": "Não deu pra criar. Tenta de novo.",
  "onboarding.landing.joinError": "Esse convite não funciona. Pede outro.",

  "onboarding.skip": "Depois eu faço",
  "onboarding.continue": "Continuar",
  "onboarding.saving": "Salvando…",

  // ------------------------------------------------------------------- voice
  // "Call" é o que se fala no Brasil — "cair na call", "tá na call" — e já
  // aparece assim na landing. "Mesh", "SFU" e "Live" ficam em inglês: são
  // rótulos técnicos e traduzir vira jargão que ninguém usa.
  //
  // Três estados parecidos, três palavras diferentes, de propósito: "Mudo" é o
  // seu microfone desligado, "Sem áudio" é você sem ouvir ninguém, e "Mutado" é
  // uma pessoa que só você abaixou pra zero. Juntar dois deles numa palavra só
  // faz o tile ficar ilegível.
  "voice.channelFallback": "Voz",
  // Fica em inglês: é o mesmo rótulo que todo mundo já lê em live/stream.
  "voice.live": "Live",
  // O limite do mesh é fato, não sugestão — a landing diz o mesmo (de 5 a 8 por
  // canal) e as duas frases têm que combinar.
  "voice.meshWarning":
    "Chegando no limite do mesh — configure um SFU pra chamadas maiores.",
  "voice.idle.body": "Entra na call pra falar. O chat continua aqui do lado.",
  "voice.join": "Entrar na call",
  "voice.connectingTo": "Conectando em {channel}…",
  "voice.cancel": "Cancelar",
  "voice.alone": "Por enquanto só você aqui.",

  "voice.tile.you": "(você)",
  "voice.tile.presenting": "Compartilhando",
  "voice.tile.deafened": "Sem áudio",
  "voice.tile.muted": "Mudo",
  "voice.tile.mutedTitle": "Microfone desligado",
  "voice.tile.silenced": "Mutado",
  "voice.tile.connecting": "Conectando",
  "voice.tile.disconnected": "Caiu",
  "voice.tile.retry": "Tentar de novo",
  "voice.tile.mutePeer": "Mutar {name}",
  "voice.tile.unmutePeer": "Desmutar {name}",
  "voice.tile.volumeFor": "Volume de {name}",
  "voice.tile.volumePercent": "{percent} por cento",

  "voice.control.mute": "Desligar o microfone",
  "voice.control.unmute": "Ligar o microfone",
  "voice.control.deafen": "Desligar o áudio",
  "voice.control.undeafen": "Ligar o áudio",
  "voice.control.share": "Compartilhar a tela",
  "voice.control.stopShare": "Parar de compartilhar a tela",
  "voice.control.shareUnavailable":
    "Compartilhar a tela (indisponível neste aparelho)",
  "voice.control.shareTaken": "Já tem alguém compartilhando a tela",
  "voice.control.leave": "Sair",

  "voice.bar.connected": "Na call",
  "voice.bar.connecting": "Conectando…",
  "voice.bar.person": "{count} pessoa",
  "voice.bar.people": "{count} pessoas",
  "voice.bar.leave": "Sair da call",
  "voice.tile.live": "Ao vivo",
  "voice.tile.holdToTalk": "Segura pra falar",
  "voice.ptt.hold": "Segura pra falar",
  "voice.ptt.transmitting": "Falando",
  "voice.ptt.blocked": "Mudo — o push-to-talk está desligado",
  "voice.ptt.hintKey": "Segura {key} ou o botão acima.",
  "voice.ptt.hintButton": "Segura o botão acima pra falar.",
  "voice.ptt.unfocused": "Esta janela não está em foco — a tecla não chega aqui. Clica aqui antes, ou usa o botão.",
  "voice.bar.pttLive": "Ao vivo",
  "voice.bar.pttIdle": "PTT",
  "voice.bar.open": "Abrir o canal de voz {name}",

  "voice.share.someone": "Alguém",
  "voice.share.youPresenting": "Você está compartilhando",
  "voice.share.peerPresenting": "{name} está compartilhando",
  "voice.share.stop": "Parar de compartilhar",
  "voice.share.fullscreen": "Tela cheia",
  "voice.share.exitFullscreen": "Sair da tela cheia",
  "voice.share.waiting": "Conectando na tela de quem está compartilhando…",
  "voice.share.fullscreenBlocked": "O navegador não abriu a tela cheia.",

  "voice.screenShareUnsupported":
    "Este navegador não faz compartilhamento de tela.",
  "voice.screenShareInsecure":
    "Compartilhar a tela precisa de conexão segura (HTTPS).",

  "voice.error.shareTaken": "Já tem alguém compartilhando a tela.",
  "voice.error.channelFull": "Este canal de voz está cheio (máximo {limit}).",
  "voice.error.micFailed": "Não foi possível acessar o microfone",
  "voice.error.micBlocked":
    "O acesso ao microfone foi bloqueado. Libera nas configurações do navegador e entra de novo.",
  "voice.error.shareFailed": "Não foi possível compartilhar a tela",
  "voice.error.shareBlocked":
    "O compartilhamento de tela foi bloqueado ou cancelado.",
  "voice.error.noVideoTrack": "A captura de tela não trouxe vídeo",
  "voice.error.transportUnsupported":
    "Esta call roda num servidor de voz que esta versão do app não usa, então você não entrou. Ninguém na call te ouve.",
  "voice.error.transportUnreachable":
    "Não deu pra falar com o servidor de voz, então você não entrou nesta call. Verifique a sua conexão e tente de novo.",

  // --- conversation calls ---
  "voice.error.cameraFailed": "Não foi possível acessar a câmera",
  "voice.error.cameraBlocked":
    "O acesso à câmera foi bloqueado. Libera nas configurações do navegador e tenta de novo.",
  "call.incoming.title": "Chamada recebida",
  "call.incoming.groupTitle": "Chamada de grupo recebida",
  "call.incoming.accept": "Atender",
  "call.incoming.decline": "Recusar",
  "call.incoming.ignore": "Ignorar",
  "call.panel.start": "Iniciar chamada",
  "call.panel.join": "Entrar na chamada",
  "call.panel.leave": "Sair",
  "call.panel.inCall": "{count} na chamada",
  "call.panel.calling": "Chamando…",
  "call.panel.connecting": "Conectando…",
  "call.panel.declined": "{name} recusou",
  "call.panel.cameraOn": "Desligar a câmera",
  "call.panel.cameraOff": "Ligar a câmera",
  "call.panel.mute": "Silenciar",
  "call.panel.unmute": "Ativar o som",
  "call.startVoice": "Iniciar chamada de voz",
  "call.startVideo": "Iniciar chamada de vídeo",
  // "Call" é como a galera fala; "entrar na chamada · 2" leria como tradução.
  "call.header.joinCount": "Entrar na call · {count}",
  "call.stage.collapse": "Recolher a call",
  "call.stage.expand": "Expandir a call",
  "call.stage.duration": "Duração da call",
  "call.stage.selfPreview": "Prévia da sua câmera",

  "channel.meta.image.error.httpsOnly":
    "O link da imagem precisa começar com https://.",
  "channel.meta.image.error.invalid": "Isso não parece um link.",
  "channel.meta.error.generic": "Não deu pra salvar. Tenta de novo.",

  // ----------------------------------------------------------------- friends
  // "Amigos", direto. "Solicitação" é como o Discord brasileiro chama o
  // pedido, então é a palavra que o público espera — mas "pedido" também
  // aparece onde a frase fica menos burocrática com ele.
  "friends.title": "Amigos",
  "friends.tab.online": "Online",
  "friends.tab.all": "Todos",
  "friends.tab.pending": "Pendentes",
  "friends.addFriend": "Adicionar amigo",
  "friends.addFriend.hint":
    "O identificador é exato — pede o nome#0000 da pessoa e digita aqui.",
  "friends.addFriend.label": "Adicionar amigo pelo identificador",
  "friends.requestSent": "Solicitação enviada pra {name}.",
  "friends.requestAccepted": "Você e {name} agora são amigos.",
  "friends.requestFailed": "Não deu pra enviar a solicitação.",
  "friends.incoming": "Recebidas — esperando você",
  "friends.outgoing": "Enviadas — esperando a pessoa",
  "friends.accept": "Aceitar",
  "friends.decline": "Recusar",
  "friends.cancelRequest": "Cancelar pedido",
  "friends.remove": "Remover amigo",
  "friends.message": "Mensagem",
  "friends.empty.online": "Ninguém por aqui agora.",
  "friends.empty.all.title": "Nenhum amigo por enquanto",
  "friends.empty.all.body":
    "Adiciona alguém pelo identificador e a pessoa aparece aqui — com uma bolinha dizendo se está online.",
  "friends.empty.pending": "Nenhuma solicitação pendente. Silêncio também é bom.",
  "friends.loadFailed": "Não deu pra carregar seus amigos — tenta de novo.",
  "friends.retry": "Tentar de novo",
  "friends.onlineCount": "{count} online",
  "friends.pendingBadge": "{count} pendente(s)",
  // ----------------------------------------------------------------- threads
  // "Thread" fica em inglês de propósito — é o que se fala em call e em chat
  // ("abre uma thread aí"); "tópico" soa fórum de 2005. Gênero feminino,
  // como o uso corrente: "a thread".
  "thread.start": "Criar thread",
  "thread.open": "Abrir thread",
  "thread.title": "Thread",
  "thread.close": "Fechar thread",
  "thread.archived": "Arquivada",
  "thread.archivedHint":
    "Parada há mais de {days} dias — responder acorda ela de novo.",
  "thread.replies.one": "{count} resposta",
  "thread.replies.many": "{count} respostas",
  "thread.noReplies": "Sem respostas ainda",
  "thread.chip.aria": "Abrir thread {name}, {replies}",
  "thread.originDeleted": "A mensagem original foi apagada",
  "thread.placeholder": "Responder na thread",
  "thread.loading": "Carregando a thread…",
  "thread.error.start": "Não deu pra criar a thread. Tenta de novo.",

  // ---------------------------------------------------------------- settings
  // Tudo em "você", nunca "tu" nem "o usuário". Termos que brasileiro fala em
  // inglês continuam em inglês: push, push-to-talk, chat, link, JSON.
  "settings.title": "Configurações",
  "settings.eyebrow": "Sua conta",
  "settings.nav.label": "Seções das configurações",
  "settings.cancel": "Cancelar",
  "settings.save": "Salvar",
  "settings.saving": "Salvando…",
  "settings.saveFailed": "Não deu pra salvar",

  "settings.section.profile": "Perfil",
  "settings.section.voice": "Voz e áudio",
  "settings.section.notifications": "Notificações",
  "settings.section.appearance": "Aparência e idioma",
  "settings.section.privacy": "Privacidade",
  "settings.section.data": "Seus dados",

  // -- perfil
  "settings.profile.description": "Como você aparece pra todo mundo.",
  "settings.profile.handle": "Seu identificador",
  "settings.profile.avatar": "Avatar",
  "settings.profile.avatar.urlPlaceholder": "https://… link da imagem",
  "settings.profile.avatar.urlLabel": "Link da imagem do avatar",
  "settings.profile.avatar.preset": "Usar avatar pronto",
  "settings.profile.avatar.clear": "Limpar",
  "settings.profile.displayName": "Nome de exibição",
  "settings.profile.username": "Nome de usuário",
  "settings.profile.usernamePlaceholder": "nome_maneiro",
  "settings.profile.usernameHint":
    "Vira nome_de_usuario#1234 — o número sai automático se já estiver em uso.",
  "settings.profile.saveNote":
    "Esta seção só vale depois que você salvar. O resto vale na hora em que você muda.",

  // -- voz e áudio
  "settings.voice.description":
    "Dispositivos e volumes valem ao entrar na voz. Mudanças com a call em andamento aplicam na hora quando dá.",
  "settings.voice.permissionNeeded":
    "Precisa liberar o microfone pra listar os dispositivos e mostrar o nível de entrada.",
  "settings.voice.inputDevice": "Microfone",
  "settings.voice.systemDefault": "Padrão do sistema",
  "settings.voice.inputVolume": "Volume de entrada",
  "settings.voice.inputLevel": "Nível de entrada",
  "settings.voice.percent": "{percent}%",
  "settings.voice.inputMode": "Modo de entrada",
  "settings.voice.mode.activity": "Por voz",
  "settings.voice.mode.activityHint":
    "Seu microfone fica aberto sempre que você não estiver mutado.",
  "settings.voice.mode.ptt": "Push-to-talk",
  "settings.voice.mode.pttHint":
    "Seu microfone fica fechado até você segurar a tecla ou o botão.",
  "settings.voice.pttKey": "Tecla do push-to-talk",
  "settings.voice.pttHint":
    "{key} funciona com esta janela em foco e sem você estar digitando. Não funciona com outro app na frente — pra isso o painel de voz tem um botão de segurar pra falar.",
  "settings.voice.pttNoKeyboard":
    "Este aparelho não tem teclado pra vincular, então o push-to-talk usa o botão de segurar pra falar no painel de voz.",
  "settings.voice.processing": "Processamento do microfone",
  "settings.voice.processing.echo": "Cancelamento de eco",
  "settings.voice.processing.echoHint":
    "Evita que os outros ouçam a própria voz voltando pela sua caixa de som.",
  "settings.voice.processing.noise": "Redução de ruído",
  "settings.voice.processing.noiseHint":
    "Tira ventilador e teclado — e algumas das suas consoantes junto.",
  "settings.voice.processing.gain": "Controle automático de ganho",
  "settings.voice.processing.gainHint":
    "Nivela seu volume, e levanta o barulho da sala entre uma frase e outra.",
  "settings.voice.processing.note":
    "Mudar isso reabre o microfone. Ninguém cai da call.",
  "settings.voice.outputDevice": "Saída de áudio",
  "settings.voice.outputUnsupported":
    "Escolher a saída de áudio não funciona neste navegador.",
  "settings.voice.outputVolume": "Volume de saída",
  "settings.voice.muteOnJoin": "Entrar na voz com o microfone mutado",
  "settings.voice.compactPeers": "Lista de pessoas compacta",

  // -- notificações
  "settings.notifications.description":
    "O que chega até você, e onde. O que estiver definido por servidor ou por canal ganha destas.",
  "settings.notifications.unsupported":
    "Este navegador não mostra notificações do sistema.",
  "settings.notifications.denied":
    "Bloqueado neste site. Libere as notificações nas configurações do site no seu navegador pra ligar de novo — a página não tem como perguntar outra vez.",
  "settings.notifications.turnOff": "Desligar",
  "settings.notifications.enable": "Ligar notificações no sistema",
  "settings.notifications.on": "Ligado nesta conta.",
  "settings.notifications.willAsk": "Seu navegador vai pedir permissão.",
  "settings.notifications.levelLabel": "Nível padrão de notificação",
  "settings.notifications.level.all": "Todas as mensagens",
  "settings.notifications.level.mentions": "Só @menções",
  "settings.notifications.level.none": "Nada",
  "settings.notifications.levelHint":
    "Vale onde o servidor ou o canal não tiver ajuste próprio. Clique com o botão direito num servidor ou canal pra mudar só aquele.",
  "settings.push.title": "Push — com o app fechado",
  "settings.push.needsInstall":
    "No iPhone e no iPad, o push só funciona pelo app instalado: abra o pqp no Safari, toque em Compartilhar, depois em “Adicionar à Tela de Início”, e ligue o push de dentro do app instalado.",
  "settings.push.unsupported": "Este navegador não recebe push.",
  "settings.push.notConfigured": "O push não está configurado neste servidor.",
  "settings.push.turnOff": "Desligar neste aparelho",
  "settings.push.enable": "Ligar push neste aparelho",
  "settings.push.on":
    "Menções, respostas e DMs chegam neste aparelho mesmo com o app fechado.",
  "settings.push.off":
    "Só menções, respostas e mensagens diretas — nunca toda mensagem.",
  "settings.push.denied":
    "As notificações estão bloqueadas neste site. Libere primeiro nas configurações do navegador.",
  "settings.push.failed":
    "Não deu pra inscrever este aparelho. Tenta de novo depois de recarregar.",
  "settings.push.unreachable":
    "Não deu pra falar com o servidor. Sua inscrição não foi salva.",
  "settings.push.dmDetails": "Mostrar quem mandou a mensagem direta",
  "settings.push.dmDetailsHint":
    "Desligado, o push de DM diz só “Nova mensagem direta”. O texto da mensagem nunca vai junto, de um jeito ou de outro.",

  // -- aparência e idioma
  "settings.appearance.description":
    "Como o pqp fica na tela, e em que idioma ele fala.",
  "settings.appearance.theme": "Tema",
  "settings.appearance.theme.light": "Claro",
  "settings.appearance.theme.dark": "Escuro",
  "settings.appearance.theme.system": "Sistema",
  "settings.appearance.resolved.light": "claro",
  "settings.appearance.resolved.dark": "escuro",
  "settings.appearance.themeFollowing":
    "Seguindo seu sistema — agora {theme}.",
  "settings.appearance.themeHint":
    "Vale na hora, e acompanha sua conta nos outros aparelhos.",
  "settings.appearance.language": "Idioma",
  "settings.appearance.languageHint":
    "A página recarrega pra trocar de idioma. Salve seu perfil antes, se estava mexendo nele.",
  "settings.appearance.language.en": "English",
  "settings.appearance.language.ptBR": "Português (Brasil)",
  "settings.appearance.chat": "Chat",
  "settings.appearance.linkPreviews": "Mostrar prévia dos links",

  // -- privacidade
  "settings.privacy.description":
    "Quem consegue te achar. A regra vale no servidor, não só aqui.",
  "settings.privacy.dmLabel": "Quem pode te mandar mensagem direta",
  "settings.privacy.dm.everyone": "Qualquer pessoa",
  "settings.privacy.dm.serverMembers": "Quem divide um servidor comigo",
  "settings.privacy.dm.nobody": "Ninguém",
  "settings.privacy.dmHint":
    "Vale pras conversas novas. Quem já está falando com você continua chegando — apertar isso não é jeito de sumir no meio da frase.",
  "settings.privacy.saveFailed": "Não deu pra salvar isso",
  "settings.privacy.blocked": "Bloqueados",
  "settings.privacy.blockedEmpty":
    "Ninguém. Bloquear alguém impede as mensagens da pessoa de chegarem até você e esconde o que ela fala nos canais em comum atrás de um toque.",
  "settings.privacy.unblock": "Desbloquear",

  // -- seus dados
  "settings.data.description":
    "Leve tudo com você, ou encerre a conta de vez.",
  "settings.data.export": "Baixar meus dados",
  "settings.data.exporting": "Preparando…",
  "settings.data.exportHint":
    "Um arquivo JSON com tudo o que a gente guarda sobre você.",
  "settings.data.exportBody":
    "Vem com seu perfil, suas configurações, cada mensagem que você escreveu, os servidores em que você está e quem você bloqueou. Não vem com mensagens que outras pessoas escreveram — nem o lado delas nas suas mensagens diretas. Aquilo é o que elas falaram, não é seu dado, e você continua lendo tudo aqui no app.",
  "settings.data.exportFailed": "Não deu pra montar sua exportação",
  "settings.data.delete": "Apagar minha conta",
  "settings.data.deleteHint":
    "É pra sempre. Não tem como desfazer nem backup pra restaurar.",

  // -- confirmação de exclusão
  "settings.delete.eyebrow": "Conta",
  "settings.delete.title": "Apagar sua conta",
  "settings.delete.keep": "Manter minha conta",
  "settings.delete.confirm": "Apagar pra sempre",
  "settings.delete.deleting": "Apagando…",
  "settings.delete.failed": "Não deu pra apagar sua conta",
  "settings.delete.lead":
    "Isso não tem volta. A gente não guarda backup pra te restaurar, e ninguém no pqp consegue trazer sua conta de volta.",
  "settings.delete.whatGoes": "O que é apagado",
  "settings.delete.goes.profile":
    "Seu perfil, seu identificador, seu avatar e suas configurações.",
  "settings.delete.goes.messages":
    "Cada mensagem que você escreveu, em todo lugar — inclusive nas mensagens diretas. As outras pessoas vão ver buracos onde estavam suas mensagens.",
  "settings.delete.goes.files":
    "Seus arquivos e imagens, e as reações que você deixou.",
  "settings.delete.goes.memberships":
    "Suas participações em servidores, suas conversas e a lista de quem você bloqueou.",
  "settings.delete.goes.signIn":
    "Seu login. Você não vai conseguir entrar de novo.",
  "settings.delete.goes.servers":
    "Qualquer servidor que seja só seu, sem mais ninguém dentro.",
  "settings.delete.whatStays": "O que fica, e por quê",
  "settings.delete.stays.moderation":
    "Registros de moderação do que você fez em servidores dos outros, sem o seu nome. Apagar uma conta não pode apagar o registro de como ela foi usada pra moderar outra pessoa.",
  "settings.delete.stays.bans":
    "Os bans que você deu. Tirar eles deixaria todo mundo que você baniu voltar pra servidores com os quais você não tem mais nada a ver.",
  "settings.delete.stays.reports":
    "Denúncias que outras pessoas fizeram sobre você, sem o seu nome. A gente não pode deixar apagar a conta virar um jeito de limpar a própria ficha.",
  "settings.delete.staysNote":
    "Tudo isso é descartado no prazo de cada um. A política de privacidade explica em detalhe.",
  "settings.delete.ownedTitle":
    "Faça uma destas primeiro, pra cada servidor que é seu",
  "settings.delete.ownedBody":
    "Ainda tem gente nesses servidores, então a gente não vai apagar eles por baixo das pessoas. Nas configurações de cada servidor, passe ele pra outro membro ou apague você mesmo.",
  "settings.delete.ownedMember": "— mais {count} pessoa",
  "settings.delete.ownedMembers": "— mais {count} pessoas",
  "settings.delete.typeLabel": "Digite seu identificador pra confirmar",
  "settings.delete.typeAria": "Digite {handle} pra confirmar a exclusão",
};
