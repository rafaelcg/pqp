# docs-apps

The public docs site for people who build **pqp apps** (`@pqp/apps-docs`, VitePress). It is also how the platform is explained to the people who run it: every page is written from the code, and the SDK reference is checked against the source.

It is a static site. It does not ship with the pqp client, is not served by the API, and no workflow deploys it yet.

## Run it

```sh
pnpm install
pnpm docs:apps          # dev server on http://localhost:5176 (hot reload)
pnpm docs:apps:build    # static site into docs-apps/.vitepress/dist
pnpm --filter @pqp/apps-docs preview   # serve the built site on 5176
pnpm --filter @pqp/apps-docs typecheck # the VitePress config, and the tutorial app's source
```

The build fails on a dead internal link, which is the check that matters most here.

## What is where

| Path | What |
|---|---|
| `index.md` | Home: what an app is, the pitch |
| `guide/getting-started.md` | The Tiny Eco tutorial, end to end |
| `concepts/` | How it works, the sandbox, the bridge, the manifest, sessions, what an app can keep, privacy |
| `sdk/` | The `@pqp/app-sdk` reference, and the manifest reference |
| `publishing/` | The packager, versions and the catalog, review, the appstore (planned) |
| `examples/` | Eco, step by step, and Locadora |
| `faq.md`, `security.md` | |
| `pt-BR/` | Portuguese: home, getting started, how an app works. The other pages are English only, and the Portuguese sidebar links to them and says so |
| `snippets/tiny-eco/` | The tutorial app as files. The guide embeds them with `<<<`, so the page cannot drift from code that was built; `typecheck` compiles them against the SDK source |
| `.vitepress/theme/` | pqp's tokens on VitePress's variables (`style.css`), and the self-hosted fonts |
| `public/` | The pixel hero, the logo and favicon (from the client), and the font files (copied from `client/src/assets/fonts`) |

## Keeping it true

Three pages quote real files, and one is a source of truth to check against when something changes.

- `sdk/*` is written from `packages/app-sdk/src` and `packages/shared/src/apps/bridge.ts`. When a signature changes, change the page in the same pull request.
- `sdk/manifest.md` follows `packages/shared/src/apps/manifest.ts`. `examples/eco.md` embeds `apps/eco` files directly.
- `docs/APPS.md` is the internal reference this grew from. If the two disagree, the code wins, then fix both.
- Two pages carry a **status note** that is true today and must be edited when it stops being true: the "What you will see today" warning in `guide/getting-started.md` (and its Portuguese copy) waits for pull request #1412, and `examples/locadora.md` waits for #1411.

## Deploying it

Nothing deploys this site. When it should go up, the plan is a Cloudflare Pages project named **`pqp-apps-docs`**, separate from the client's `pqp` project and from `pqp-apps` (which serves app bundles and must stay a different registrable domain from pqp.gg, see `docs/APPS.md`).

| Setting | Value |
|---|---|
| Project name | `pqp-apps-docs` |
| Build command | `pnpm install --frozen-lockfile && pnpm --filter @pqp/apps-docs build` |
| Build output directory | `docs-apps/.vitepress/dist` |
| Root directory | the repository root |
| Node version | 22 (`NODE_VERSION=22`) |
| Environment | none needed; `DOCS_BASE` only for the path option below |

A manual deploy, with the same wrangler the other workflows use: `npx wrangler pages deploy docs-apps/.vitepress/dist --project-name pqp-apps-docs`.

### Where it lives: `developers.pqp.gg` or `pqp.gg/apps/docs`

This is a decision, not made here. The tradeoffs:

| | `developers.pqp.gg` (its own subdomain) | `pqp.gg/apps/docs` (a path on the main site) |
|---|---|---|
| Setup | A Pages custom domain and one DNS record. Builds with `DOCS_BASE` unset. | The client's Pages project would have to proxy `/apps/docs/*` to this project (a Pages Function or a redirect rule), and the site must build with `DOCS_BASE=/apps/docs/`. Moves with every client deploy risk. |
| Isolation | Its own deploy, its own cache, its own failures. A docs build cannot break the app, and a client deploy cannot break the docs. | Shares the client's project, headers and service worker. `client/public/_headers` and the client's service worker scope (`/`) would apply to it, and would need an exception. |
| Search and SEO | A separate host builds its own authority and sitemap; links from `pqp.gg` are external links. | Inherits pqp.gg's domain authority and sits in the same sitemap. |
| Cookies and security | A different origin from the app that holds sessions. No docs script can ever read the app's storage. | Same origin as `/app`: a script on a docs page could reach pqp's `localStorage`. The docs ship no third-party script, but the boundary would be a promise instead of the browser's rule. |
| Brand | Reads as "the developer site", the convention (`developers.`, `docs.`). | Reads as part of the product. |

The default in this repository is the subdomain, because it keeps the browser's origin rule between the docs and the app for free and needs no change to the client. The one real argument for the path is search authority, which a link and a sitemap entry from pqp.gg largely recover.

### CI

CI builds this site on every pull request (the `static` job's "Build the apps docs" step), so a dead link or a broken page fails the pull request. No workflow deploys it. The deploy workflow, when there is one, should mirror `deploy-apps.yml`: gated on a repository variable such as `DOCS_APPS_PAGES_PROJECT`, empty means skip.
