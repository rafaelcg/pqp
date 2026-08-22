/**
 * What the QG do pqp looks like. The whole content surface, in one file.
 *
 * DELIBERATELY NOT IN `tools/ambient/personas.yaml`. That file describes
 * communities with an AI cast, and its loader refuses a community with fewer
 * than two personas because a scene needs two sides. The QG has no cast by
 * owner decision: every new account lands here, so the room fills with real
 * people at the rate the product signs them up, and residents would crowd out
 * exactly the conversations that make arriving worthwhile. Keeping the QG out
 * of that config is also the safest way to make sure nobody adds a cast to it
 * by editing the wrong block.
 *
 * WHY CHANNELS AND NOT ONE ROOM. A person who lands here should be able to see,
 * without asking, what kind of place it is and where their thing goes. Five
 * channels each with a job does that; one general channel makes everybody guess
 * and turns the first question into an interruption.
 *
 * The welcome is the pinned post. It is written to be read by somebody who
 * arrived thirty seconds ago and does not yet know what pqp is, so it says what
 * works, what does not, and where to put a complaint. No em dashes.
 */

export const QG = {
  /** Matched by name when seeding, so a re-run updates rather than duplicates. */
  name: "QG do pqp",
  slug: "qg-do-pqp",
  category: "tech",
  language: "pt",
  /**
   * The old one read "O QG oficial do pqp — avisos, suporte e caça aos bugs.
   * Entra." Two problems: an em dash, against the house rule and on a public
   * page, and "suporte" promises a support desk that one person cannot staff.
   */
  tagline:
    "O quartel general do pqp. Avisos, ajuda, e o lugar certo pra reclamar quando quebrar.",

  channels: [
    {
      name: "chegou-agora",
      type: "text",
      topic: "Diz oi. Conta o que te trouxe aqui e o que você quer fazer com o pqp.",
    },
    {
      name: "avisos",
      type: "text",
      topic: "O que mudou e quando. Só a gente escreve aqui, é pra ler e seguir a vida.",
    },
    {
      name: "ajuda",
      type: "text",
      topic: "Travou, sumiu, não conecta. Pergunta aqui que alguém responde.",
    },
    {
      name: "caca-bugs",
      type: "text",
      topic:
        "Achou bug, conta aqui. Bug confirmado vira badge de caça-bugs no teu perfil.",
    },
    {
      name: "papo-reto",
      type: "text",
      topic: "Off topic. O que não cabe nos outros, cabe aqui.",
    },
    {
      name: "call-aberta",
      type: "voice",
      topic: "Call aberta. Entra, testa a voz e a tela, vê se presta.",
    },
  ],

  /**
   * Pinned in the first text channel. Deliberately says what does NOT work:
   * somebody who finds the limit themselves after being sold the feature trusts
   * the next sentence less, and every limit here is one they would hit today.
   */
  welcome: [
    "bem-vindo ao QG. esse é o quartel general do pqp, e você caiu aqui porque toda conta nova cai.",
    "",
    "**o que dá pra fazer agora:**",
    "voz e texto no navegador, sem instalar nada. tela compartilhada com som, se você compartilhar uma guia do chrome e marcar a caixinha de áudio da guia. câmera na call. tudo de graça.",
    "",
    "**o que ainda não dá:**",
    "tela inteira no mac sai muda, e no safari e firefox também. isso é limite do navegador, não escolha nossa. transmitir a tela do iPhone ainda não rola, só assistir. e serviço com DRM tipo netflix continua saindo preto, com som ou sem.",
    "",
    "**onde botar cada coisa:**",
    "`#chegou-agora` pra se apresentar, `#ajuda` quando travar, `#caca-bugs` quando quebrar de verdade, `#papo-reto` pro resto. `#call-aberta` tá sempre aberta se você quiser testar a voz com alguém.",
    "",
    "o pqp é beta e é feito por uma pessoa só. o código é aberto: github.com/rafaelcg/pqp. se achar bug, fala. bug confirmado vira badge no teu perfil.",
  ].join("\n"),
};
