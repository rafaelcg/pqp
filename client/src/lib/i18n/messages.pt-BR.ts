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
};
