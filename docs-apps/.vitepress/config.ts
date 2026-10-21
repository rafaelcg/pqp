import { defineConfig, type DefaultTheme } from "vitepress";

/**
 * The docs site for people who build pqp apps. Static, no analytics, no
 * third-party font or script: search is VitePress's own local index and the
 * fonts are the same self-hosted files the pqp client ships.
 *
 * `DOCS_BASE` is for hosting under a path (for example `/apps/docs/` behind
 * pqp.gg). It defaults to `/`, which is what a host of its own
 * (developers.pqp.gg) wants. See ../README.md for the tradeoff.
 */
const base = process.env.DOCS_BASE ?? "/";
const repo = "https://github.com/rafaelcg/pqp";

function sidebarEn(): DefaultTheme.Sidebar {
  return [
    {
      text: "Start here",
      items: [
        { text: "What is a pqp app", link: "/" },
        { text: "Getting started", link: "/guide/getting-started" },
      ],
    },
    {
      text: "Concepts",
      collapsed: false,
      items: [
        { text: "How an app works", link: "/concepts/how-it-works" },
        { text: "The sandbox", link: "/concepts/sandbox" },
        { text: "The bridge", link: "/concepts/bridge" },
        { text: "The manifest and capabilities", link: "/concepts/manifest" },
        { text: "Sessions and participants", link: "/concepts/sessions" },
        { text: "What an app can keep", link: "/concepts/storage" },
        { text: "What an app never sees", link: "/concepts/privacy" },
      ],
    },
    {
      text: "SDK reference",
      collapsed: false,
      items: [
        { text: "Overview and install", link: "/sdk/" },
        { text: "connect()", link: "/sdk/connect" },
        { text: "The app object", link: "/sdk/app" },
        { text: "Errors", link: "/sdk/errors" },
        { text: "Theme", link: "/sdk/theme" },
        { text: "Types and low level", link: "/sdk/types" },
        { text: "Manifest reference", link: "/sdk/manifest" },
      ],
    },
    {
      text: "Publishing",
      collapsed: false,
      items: [
        { text: "Build and package", link: "/publishing/" },
        { text: "Versions and the catalog", link: "/publishing/versions" },
        { text: "Review and availability", link: "/publishing/review" },
        { text: "The appstore (planned)", link: "/publishing/appstore" },
      ],
    },
    {
      text: "Examples",
      collapsed: false,
      items: [
        { text: "Eco, step by step", link: "/examples/eco" },
        { text: "Locadora", link: "/examples/locadora" },
      ],
    },
    {
      text: "More",
      items: [
        { text: "FAQ", link: "/faq" },
        { text: "Security", link: "/security" },
      ],
    },
  ];
}

// The pt-BR locale is partial on purpose: the pages that exist in Portuguese
// are listed with a plain label, the rest point at the English page and say so.
function sidebarPt(): DefaultTheme.SidebarItem[] {
  return [
    {
      text: "Começa aqui",
      items: [
        { text: "O que é um app do pqp", link: "/pt-BR/" },
        { text: "Primeiros passos", link: "/pt-BR/guide/getting-started" },
      ],
    },
    {
      text: "Conceitos",
      collapsed: false,
      items: [
        { text: "Como um app funciona", link: "/pt-BR/concepts/how-it-works" },
        { text: "A sandbox (em inglês)", link: "/concepts/sandbox" },
        { text: "A ponte (em inglês)", link: "/concepts/bridge" },
        { text: "O manifest (em inglês)", link: "/concepts/manifest" },
        { text: "Sessões e participantes (em inglês)", link: "/concepts/sessions" },
        { text: "O que um app nunca vê (em inglês)", link: "/concepts/privacy" },
      ],
    },
    {
      text: "Referência (em inglês)",
      collapsed: false,
      items: [
        { text: "SDK", link: "/sdk/" },
        { text: "Publicar", link: "/publishing/" },
        { text: "Exemplos", link: "/examples/eco" },
        { text: "FAQ", link: "/faq" },
        { text: "Segurança", link: "/security" },
      ],
    },
  ];
}

export default defineConfig({
  title: "pqp apps",
  description:
    "Write a call app in an afternoon. The SDK, the sandbox and the docs for building apps that run inside pqp channels.",
  lang: "en-US",
  base,
  cleanUrls: true,
  // the deploy notes and the tutorial's source files are not pages
  srcExclude: ["README.md", "snippets/**"],
  // links to localhost are for the reader's own machine; every other dead link fails the build
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: false,
  appearance: true,
  head: [
    ["link", { rel: "icon", type: "image/png", href: `${base}favicon.png` }],
    ["meta", { name: "theme-color", content: "#14181d" }],
    ["link", { rel: "preload", href: `${base}fonts/instrument-sans-latin.woff2`, as: "font", type: "font/woff2", crossorigin: "" }],
    ["link", { rel: "preload", href: `${base}fonts/gabarito-latin.woff2`, as: "font", type: "font/woff2", crossorigin: "" }],
  ],
  themeConfig: {
    logo: "/logo.png",
    siteTitle: "pqp apps",
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: repo }],
    editLink: {
      pattern: `${repo}/edit/main/docs-apps/:path`,
      text: "Edit this page on GitHub",
    },
    outline: { level: [2, 3], label: "On this page" },
    footer: {
      message: "Open source under the AGPL-3.0, like pqp.",
      copyright: "pqp.gg",
    },
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
          { text: "Concepts", link: "/concepts/how-it-works", activeMatch: "/concepts/" },
          { text: "SDK", link: "/sdk/", activeMatch: "/sdk/" },
          { text: "Publishing", link: "/publishing/", activeMatch: "/publishing/" },
          { text: "Examples", link: "/examples/eco", activeMatch: "/examples/" },
          { text: "FAQ", link: "/faq" },
        ],
        sidebar: sidebarEn(),
      },
    },
    "pt-BR": {
      label: "Português (BR)",
      lang: "pt-BR",
      link: "/pt-BR/",
      description:
        "Faz um app de call numa tarde. O SDK, a sandbox e a documentação pra quem constrói apps que rodam nos canais do pqp.",
      themeConfig: {
        nav: [
          { text: "Primeiros passos", link: "/pt-BR/guide/getting-started", activeMatch: "/pt-BR/guide/" },
          { text: "Como funciona", link: "/pt-BR/concepts/how-it-works" },
          { text: "SDK (en)", link: "/sdk/" },
          { text: "Publicar (en)", link: "/publishing/" },
        ],
        sidebar: { "/pt-BR/": sidebarPt() },
        outline: { level: [2, 3], label: "Nesta página" },
        docFooter: { prev: "Anterior", next: "Próxima" },
        darkModeSwitchLabel: "Tema",
        sidebarMenuLabel: "Menu",
        returnToTopLabel: "Voltar ao topo",
        langMenuLabel: "Idioma",
        editLink: {
          pattern: `${repo}/edit/main/docs-apps/:path`,
          text: "Editar essa página no GitHub",
        },
        footer: {
          message: "Código aberto sob a AGPL-3.0, igual ao pqp.",
          copyright: "pqp.gg",
        },
      },
    },
  },
});
