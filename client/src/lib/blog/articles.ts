import type { BlogLocale } from "./posts";

/**
 * The guide index: tactical, evergreen articles, next to but not mixed into
 * `posts.ts`.
 *
 * WHY A SEPARATE LIST FROM `POSTS`. A release note describes a day — it has
 * no `dateModified` on purpose (see `blog-meta.ts`), its JSON-LD is
 * `BlogPosting`, and the project's own rule is that it is a weekly catch-up,
 * never written for a single PR. A guide is the opposite shape: it answers a
 * question ("how do I watch a film with friends online") that does not care
 * what shipped this week, it gets corrected in place when the product
 * changes under it, and it wants `Article` + `FAQPage` structured data, not a
 * publication date pinned to one Tuesday. Folding the two into one list would
 * mean either lying about a guide's date to satisfy the "newest first, no
 * live edits" invariant `blog-meta.test.ts` holds `POSTS` to, or weakening
 * that invariant for release notes to accommodate guides. Two lists, two
 * contracts, same `/blog/<slug>` URL space and the same index page —
 * `blog-page.tsx` renders both, in their own sections.
 *
 * WHAT LIVES HERE VS `article-bodies.ts`. Same split as `posts.ts` /
 * `bodies.ts`, for the same hard reason: `blog-meta.ts` is in the Pages
 * middleware's import graph, wrangler bundles that with esbuild, and esbuild
 * has no loader for `.md`. Metadata — slug, dates, title, summary, FAQ — goes
 * here because the edge needs it for the head and the JSON-LD. Prose goes in
 * `article-bodies.ts`, which nothing edge-reachable may import.
 *
 * ENGLISH IS OPTIONAL, PORTUGUESE IS NOT. Four of the six launch guides have
 * no English body — the audience they target searches in Portuguese — so
 * `title`/`summary`/a question's `en` are all optional and every reader
 * falls back to the Portuguese copy, same as `loadArticleBody` falls back to
 * a Portuguese body. Use `articleTitle` / `articleSummary` / `articleFaq`
 * rather than indexing the record directly, so the fallback happens in one
 * place instead of at every call site.
 *
 * `faq` IS SCHEMA FOR COPY THE PAGE ACTUALLY RENDERS, never schema alone —
 * same rule `marketing-meta.ts` holds `/vs-discord` and `/tela` to. Every
 * question here has to appear, asked the same way, in the article's own
 * "Perguntas frequentes" section.
 *
 * ADDING A GUIDE: write the markdown under `content/blog/`, add an importer
 * to `ARTICLE_BODIES` in `article-bodies.ts`, add an entry here, add the URL
 * to `client/public/sitemap.xml`, and add the query it targets to
 * `docs/SEO.md`.
 */

/** Portuguese required, English optional — see the file comment on why. */
type Localized = { "pt-BR": string; en?: string };

export interface ArticleFaqItem {
  question: Localized;
  answer: Localized;
}

export interface BlogArticle {
  /** URL segment, same namespace as `BlogPost["slug"]` — never changed once published. */
  slug: string;
  /** `YYYY-MM-DD`, first published. */
  date: string;
  /** Last time the prose changed in a way worth telling a crawler about. */
  updated: string;
  title: Localized;
  /** Meta description and card blurb. Kept under 160 characters, unlike a release note's 200. */
  summary: Localized;
  /** Locales with an actual written body. The other falls back to `pt-BR`, same as `loadPostBody`. */
  locales: readonly BlogLocale[];
  faq: readonly ArticleFaqItem[];
}

function pick(text: Localized, locale: BlogLocale): string {
  return (locale === "en" ? text.en : undefined) ?? text["pt-BR"];
}

export function articleTitle(article: BlogArticle, locale: BlogLocale): string {
  return pick(article.title, locale);
}

export function articleSummary(article: BlogArticle, locale: BlogLocale): string {
  return pick(article.summary, locale);
}

export function articleFaq(
  article: BlogArticle,
  locale: BlogLocale,
): Array<{ question: string; answer: string }> {
  return article.faq.map((item) => ({
    question: pick(item.question, locale),
    answer: pick(item.answer, locale),
  }));
}

/** Newest first, same convention as `POSTS`, pinned by `articles.test.ts`. */
export const ARTICLES: readonly BlogArticle[] = [
  {
    slug: "pqp-vs-discord-2026",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: {
      "pt-BR": "pqp vs Discord em 2026: comparação honesta",
      en: "pqp vs Discord in 2026: an honest comparison",
    },
    summary: {
      "pt-BR":
        "O que o pqp já faz melhor que o Discord, o que ainda não faz, e quando faz sentido trocar. Sem número inventado, só o que roda hoje.",
      en: "What pqp already does better than Discord, what it still does not, and when switching actually makes sense. No invented numbers, only what runs today.",
    },
    locales: ["pt-BR", "en"],
    faq: [
      {
        question: { "pt-BR": "pqp é de graça?", en: "Is pqp free?" },
        answer: {
          "pt-BR":
            "Sim. Voz, texto, watch party e criar servidor não custam nada, e o código é aberto (AGPL-3.0): dá pra ler, rodar e até hospedar você mesmo.",
          en: "Yes. Voice, text, watch parties and creating a server cost nothing, and the code is open source under AGPL-3.0: you can read it, run it, and self-host it yourself.",
        },
      },
      {
        question: {
          "pt-BR": "O pqp é só um clone do Discord?",
          en: "Is pqp just a Discord clone?",
        },
        answer: {
          "pt-BR":
            "A base é parecida de propósito (servidores, canais, cargos), porque é isso que resolve o problema. O que muda é o que veio depois: watch party com mixer e qualidade ajustável embutidos, screen share com áudio sem plugin, código aberto, e um time que responde rápido.",
          en: "The base is deliberately similar (servers, channels, roles) because that shape solves the problem. What differs is what came after it: a built-in watch party with a mixer and adjustable quality, screen share with audio and no plugin, open source code, and a team that answers fast.",
        },
      },
      {
        question: {
          "pt-BR": "Dá pra importar meu servidor do Discord?",
          en: "Can I import my Discord server?",
        },
        answer: {
          "pt-BR":
            "Dá pra copiar o layout: categorias, canais e cargos de um Discord Guild Template, colando o link ao criar uma comunidade no pqp. Não copia membros, mensagens nem emoji customizado, porque isso não está no template.",
          en: "You can copy the layout: categories, channels and roles from a Discord Guild Template, by pasting the link when creating a community in pqp. It does not copy members, messages or custom emoji, because those are not in the template.",
        },
      },
      {
        question: {
          "pt-BR": "O que o Discord ainda faz que o pqp não faz?",
          en: "What does Discord still do that pqp does not?",
        },
        answer: {
          "pt-BR":
            "Um catálogo de bots de terceiros do tamanho do Discord, canais de fórum, e um diretório público de milhões de servidores. O pqp tem comunidades públicas e o próprio import de layout do Discord, mas o ecossistema de bots de terceiros ainda é menor, porque é mais novo.",
          en: "A third-party bot ecosystem the size of Discord's, forum channels, and a public directory of millions of servers. pqp has public communities and the Discord layout import itself, but the third-party bot ecosystem is still smaller, simply because it is younger.",
        },
      },
    ],
  },
  {
    slug: "watch-party-assistir-filme-com-amigos",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: {
      "pt-BR": "Como assistir um filme junto online com os amigos (passo a passo)",
      en: "How to watch a film together online with friends (step by step)",
    },
    summary: {
      "pt-BR":
        "Watch party no pqp: abre a call, compartilha a guia, todo mundo assiste e comenta junto. O passo a passo de quem apresenta e de quem só assiste.",
      en: "A watch party in pqp: start a call, share the tab, everyone watches and reacts together. The steps for whoever presents, and for everyone just watching.",
    },
    locales: ["pt-BR", "en"],
    faq: [
      {
        question: {
          "pt-BR": "Preciso instalar alguma coisa pra fazer uma watch party?",
          en: "Do I need to install anything to run a watch party?",
        },
        answer: {
          "pt-BR":
            "Não. Pra apresentar do navegador, usa Chrome ou Edge (o Firefox não compartilha uma guia com segurança, então fica de fora). Pra apresentar do computador tem o app de desktop também. Pra assistir, qualquer navegador ou o app funciona.",
          en: "No. To present from the browser, use Chrome or Edge (Firefox cannot share a tab securely, so it is left out). There is also a desktop app to present from. To just watch, any browser or the app works.",
        },
      },
      {
        question: {
          "pt-BR": "O som do filme vai junto?",
          en: "Does the film's audio come through?",
        },
        answer: {
          "pt-BR":
            "Sim: quando você compartilha a guia do Chrome ou Edge onde o filme está tocando, o som daquela guia vai junto automaticamente. Um mixer deixa você equilibrar seu microfone com o áudio do filme, e abaixa o filme sozinho quando você fala.",
          en: "Yes: when you share the Chrome or Edge tab the film is playing in, that tab's audio comes through automatically. A mixer lets you balance your microphone against the film's audio, and it ducks the film on its own while you talk.",
        },
      },
      {
        question: {
          "pt-BR": "Quantas pessoas podem assistir junto?",
          en: "How many people can watch together?",
        },
        answer: {
          "pt-BR":
            "Uma watch party de mais de 500 pessoas assistindo ao mesmo tempo já rodou no pqp. Quem assiste não precisa de microfone nem de entrar na call pra ver: só clica Assistir.",
          en: "A watch party with over 500 people watching at the same time has already run on pqp. Whoever is watching does not need a microphone or to join the call to see it: they just click Watch.",
        },
      },
      {
        question: {
          "pt-BR": "Dá pra pedir pra falar durante a watch party?",
          en: "Can I ask to speak during the watch party?",
        },
        answer: {
          "pt-BR":
            "Sim. Quem só está assistindo tem um botão Pedir pra falar, e o host decide quem sobe no palco com voz. O host também pode passar a apresentação pra um co-host sem cortar a transmissão.",
          en: "Yes. Anyone just watching has a Request to speak button, and the host decides who gets a voice on stage. The host can also hand off presenting to a co-host without cutting the stream.",
        },
      },
      {
        question: {
          "pt-BR": "Se eu sair do canal, a watch party para?",
          en: "If I leave the channel, does the watch party stop?",
        },
        answer: {
          "pt-BR":
            "Não pra você: ela encolhe pro canto da tela e continua tocando enquanto você navega em outra parte do pqp. Pros outros, a party continua rodando normalmente.",
          en: "Not for you: it shrinks into a corner of the screen and keeps playing while you browse another part of pqp. For everyone else, the party keeps running as normal.",
        },
      },
    ],
  },
  {
    slug: "compartilhar-tela-com-audio",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: {
      "pt-BR": "Como compartilhar tela com áudio (Windows, Mac, navegador e celular)",
    },
    summary: {
      "pt-BR":
        "Cada navegador e cada sistema trata o áudio da tela de um jeito diferente. O que funciona de verdade hoje, plataforma por plataforma.",
    },
    locales: ["pt-BR"],
    faq: [
      {
        question: { "pt-BR": "Por que às vezes minha tela compartilhada não tem som?" },
        answer: {
          "pt-BR":
            "Porque o navegador, não o pqp, decide se entrega o áudio. Safari e Firefox nunca entregam o som de uma tela compartilhada. Chrome e Edge entregam quando você compartilha uma guia (com a caixinha de áudio marcada) ou a tela inteira no Windows.",
        },
      },
      {
        question: { "pt-BR": "Como eu garanto que o som vai junto no Chrome?" },
        answer: {
          "pt-BR":
            "Compartilhe uma guia (não a janela inteira nem uma tela) e marque a caixinha \"Também compartilhar áudio da guia\" na janela que o Chrome abre antes de confirmar. É a rota mais confiável em qualquer sistema operacional.",
        },
      },
      {
        question: { "pt-BR": "No Mac dá pra compartilhar tela inteira com som?" },
        answer: {
          "pt-BR":
            "Pelo navegador, não: é um limite do Chrome no macOS, não do pqp. Compartilhando uma guia do Chrome o som vai normalmente, em qualquer sistema.",
        },
      },
      {
        question: { "pt-BR": "Dá pra compartilhar a tela do celular?" },
        answer: {
          "pt-BR":
            "No Android, o app nativo já manda e recebe tela compartilhada. No iPhone hoje dá pra assistir a uma tela compartilhada dentro do app; transmitir a tela a partir do iPhone ainda está em desenvolvimento.",
        },
      },
    ],
  },
  {
    slug: "migrar-servidor-discord-para-pqp",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: { "pt-BR": "Como migrar (copiar) seu servidor do Discord pro pqp" },
    summary: {
      "pt-BR":
        "Cola o link de um Discord Guild Template e o pqp recria a árvore de categorias, canais e cargos. O que copia, o que não copia, e o passo a passo.",
    },
    locales: ["pt-BR"],
    faq: [
      {
        question: { "pt-BR": "Isso é um login no Discord ou um bot no meu servidor?" },
        answer: {
          "pt-BR":
            "Nenhum dos dois. Você cola um link público de template (discord.new/…), o pqp lê a estrutura dele e cria uma comunidade nova. Não entra na sua conta do Discord, não vira bot, e o Discord original não muda em nada.",
        },
      },
      {
        question: { "pt-BR": "O que é copiado de verdade?" },
        answer: {
          "pt-BR":
            "Nome do servidor, categorias, canais de texto e voz na mesma ordem, os nomes dos canais com emoji e espaço incluídos, tópicos, cargos com cor e permissões básicas mapeadas, overwrites de privacidade e o ícone do servidor quando disponível.",
        },
      },
      {
        question: { "pt-BR": "O que fica pra trás?" },
        answer: {
          "pt-BR":
            "Membros, mensagens, anexos, emoji customizado, webhooks, bans e convites do Discord: nada disso está no template, então nada disso é copiado. Canais de fórum, anúncio e palco viram texto ou voz, o que for mais parecido.",
        },
      },
      {
        question: { "pt-BR": "Como eu pego o link do template?" },
        answer: {
          "pt-BR":
            "No Discord: Configurações do servidor → Modelos → cria e copia o link (começa com discord.new/). No pqp: criar comunidade → Copiar um layout do Discord → cola o link → confere a prévia → confirma.",
        },
      },
    ],
  },
  {
    slug: "chat-de-voz-para-comunidade-de-streamer",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: {
      "pt-BR": "Chat de voz para comunidade de streamer: por que ter um servidor além da live",
    },
    summary: {
      "pt-BR":
        "A live acaba e a comunidade continua em algum lugar. Por que um servidor de voz e texto junta a audiência entre uma transmissão e outra.",
    },
    locales: ["pt-BR"],
    faq: [
      {
        question: { "pt-BR": "Preciso saber programar pra criar um servidor?" },
        answer: {
          "pt-BR":
            "Não. Criar um servidor é um botão dentro do pqp. Você nomeia, escolhe canais de texto e voz, e gera um link de convite pra mandar pro seu chat ou pra bio da live.",
        },
      },
      {
        question: { "pt-BR": "Quantas pessoas cabem numa call de voz?" },
        answer: {
          "pt-BR":
            "Uma call pequena (até 8 pessoas) roda direto entre os participantes. Passou disso, o servidor muda sozinho pro mesmo tipo de infraestrutura (LiveKit) que sustentou uma watch party de mais de 500 espectadores, sem o dono do servidor precisar configurar nada.",
        },
      },
      {
        question: { "pt-BR": "Dá pra ter moderadores e cargos como VIP?" },
        answer: {
          "pt-BR":
            "Sim. Além de dono e admin, dá pra criar cargos com nome e cor próprios (Moderador, VIP, o que fizer sentido pra sua comunidade) e escolher exatamente o que cada um pode fazer, canal por canal.",
        },
      },
      {
        question: { "pt-BR": "Dá pra mostrar minha Twitch no meu perfil do pqp?" },
        answer: {
          "pt-BR":
            "Sim, como conexão opcional no seu perfil público (pqp.gg/@seuarroba), do mesmo jeito que outras plataformas mostram conexões de jogo e streaming: você escolhe mostrar ou não.",
        },
      },
    ],
  },
  {
    slug: "instalar-pqp-android-iphone-pc",
    date: "2026-09-17",
    updated: "2026-09-17",
    title: { "pt-BR": "Como instalar o pqp no Android, iPhone e computador" },
    summary: {
      "pt-BR":
        "A web sempre funciona sem instalar nada. Pra voz em segundo plano e compartilhar tela no celular, tem app nativo de Android, beta de iPhone e app de PC.",
    },
    locales: ["pt-BR"],
    faq: [
      {
        question: { "pt-BR": "Preciso instalar alguma coisa pra usar o pqp?" },
        answer: {
          "pt-BR":
            "Não. pqp.gg funciona direto no navegador, em qualquer sistema. Instalar um app nativo é pra quem quer voz que sobrevive em segundo plano no celular, ou compartilhar tela a partir do Android.",
        },
      },
      {
        question: { "pt-BR": "Onde eu baixo o pqp no Android?" },
        answer: {
          "pt-BR":
            "Tem um APK direto em pqp.gg/android, e o app também está no Google Play em teste aberto. Voz, texto, DM, lista de amigos e compartilhar tela (enviar e receber) já rodam nativamente.",
        },
      },
      {
        question: { "pt-BR": "Tem pqp pra iPhone?" },
        answer: {
          "pt-BR":
            "Tem um beta público pelo TestFlight (pqp.gg/beta). Voz, texto e ver uma tela compartilhada já funcionam no celular. Ainda não está na App Store.",
        },
      },
      {
        question: { "pt-BR": "Tem app de desktop pro Windows, Mac ou Linux?" },
        answer: {
          "pt-BR":
            "Tem, em pqp.gg/download. É o mesmo cliente web dentro de um app Electron, com watch party apresentável direto da área de trabalho.",
        },
      },
    ],
  },
] as const;

export function articleBySlug(slug: string): BlogArticle | null {
  return ARTICLES.find((article) => article.slug === slug) ?? null;
}
