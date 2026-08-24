# Contributing to pqp

Thanks for wanting to. pqp is built by two brothers in their spare time, so a
good bug report is worth as much as a patch, and telling us something is
confusing is worth more than both.

**Português:** pode abrir issue e PR em português. A gente responde nos dois idiomas.
O texto abaixo está em inglês só porque o resto do repositório está.

## Before you write code

**Small and obvious?** Send the PR. A typo, a broken link, a clear bug with a
clear fix. No need to ask first.

**Bigger than that?** Open an issue and talk to us first. Not for ceremony:
this project has opinions that are not obvious from the outside, and we would
rather disagree with you before you spend a weekend than after. A feature that
works fine but pulls the product somewhere we do not want to go is the worst
outcome for everybody, and it is our fault if we let you build it.

**Reporting instead of fixing is a real contribution.** If you used pqp with
friends and something annoyed you, tell us. We have very little of that kind of
feedback and it is the hardest thing to get.

**Check [the open issues](https://github.com/rafaelcg/pqp/issues) first.** They
are the ranked version of what we actually want next, taken from
[`docs/DISCORD_GAPS.md`](./docs/DISCORD_GAPS.md), which measures pqp against
Discord feature by feature. Anything labelled `good first issue` is small,
self-contained and hard to get wrong. Picking from there means you already have
a yes before you start.

## Setup

```bash
pnpm install
cp .env.example .env
cp .env.example client/.env
docker compose up -d postgres
pnpm dev
```

Client on http://localhost:5173, server on http://localhost:3001.

You do not need Clerk keys to work on most things. Set `DEV_AUTH_BYPASS=true` in
the root `.env` and `VITE_DEV_AUTH_BYPASS=true` in `client/.env`, then restart
the server. The bypass is ignored when `NODE_ENV=production`.

For attachments or the e2e suite you also need MinIO:

```bash
docker compose --profile storage up -d postgres minio minio-init
```

## Four things that will waste your time if nobody tells you

These are not style preferences. Each one has cost somebody an hour.

**1. Build `@pqp/shared` before you run tests.**

```bash
pnpm --filter @pqp/shared build
```

A stale build of the shared package produces test failures in the client that
have nothing to do with your change. If tests fail in files you never touched,
run this first and try again before you start debugging.

**2. The e2e suite needs MinIO running.** Without it you get failures that look
like application bugs and are not.

**3. Copy lives in two catalogues, and there are no em dashes.**
`client/src/locales/en/translation.json` and `client/src/locales/pt-BR/translation.json`
must both carry every key. A test fails the build if an em dash, en dash or
horizontal bar appears in either. This is deliberate: they are not in the voice
the product is written in. Use a comma, a full stop, or restructure the
sentence. See [`docs/I18N.md`](./docs/I18N.md).

Some copy is duplicated in `client/src/lib/marketing-meta.ts`, because the
Cloudflare Pages middleware that injects SEO tags cannot read the i18n
catalogue. A test pins the two copies together, so if you edit marketing copy in
one place and CI complains, that is why.

**4. Touching `packages/` restarts the production API and drops every live
call.** The server compiles `@pqp/shared` into itself, so a change there is a
server change even when the feature is entirely client-side. This is not a
reason to avoid it, just something to say in the PR so it can be merged at a
sensible hour. Details in [`docs/DEPLOY.md`](./docs/DEPLOY.md).

## Before you open the PR

```bash
pnpm --filter @pqp/shared build
pnpm -r typecheck
pnpm --filter @pqp/client test
pnpm --filter @pqp/client i18n:check
pnpm lint
```

There are some pre-existing `react-hooks/exhaustive-deps` warnings about `t`.
They are not yours; leave them.

## On tests

Write one when the thing you fixed could come back. Do not write one to make a
number go up.

The specific failure worth naming: a test that asserts a property rather than
the behaviour. Video is the classic. A `<video>` element bound to a dead remote
track still reports `readyState: 4`, still has an `srcObject`, is still visible,
and shows a black rectangle. A test asserting any of those passes on a broken
call. `client/e2e/screen-reshare.spec.ts` measures decoded frames instead, and
the comment at the top explains why. That is the standard.

The client unit suite runs in Node with no DOM, so component interaction is not
directly testable. Extract the decision into a pure function and test that
properly, the way `screen-fullscreen.ts` and `video-quality.ts` do.

## Never commit

Real secret values, in code, tests, docs or commit messages. Not even expired
ones, not even as examples. Use names only. `.env` is ignored and should stay
that way.

## Licensing, and being straight with you about money

pqp is **AGPL-3.0-only**. Your contribution is accepted under that same licence,
and you keep the copyright in what you wrote. Sign your commits off to say you
have the right to contribute it:

```bash
git commit -s -m "your message"
```

That adds a `Signed-off-by` line, which is the
[Developer Certificate of Origin](https://developercertificate.org/). It is a
statement that the work is yours to give. It does **not** assign anything to us.

**The part people deserve to know up front:** pqp.gg is a hosted service and it
may charge money at some point, for hosting, higher limits or support. AGPL does
not prevent that, and it means contributions to this repository can end up in a
service that earns revenue. That is normal for open source and we would rather
say it plainly than have you discover it later.

What that also means in the other direction: anyone can run pqp themselves,
free, forever, with every feature. If somebody runs a modified version as a
service, AGPL requires them to publish their changes. That protection applies to
your contributions exactly as it applies to ours.

If pqp ever needs to be licensed on other terms to somebody, that requires the
permission of everyone who holds copyright in it, including you. We are not
asking for that permission in advance.

## Review, and the honest part about "no"

Two of us maintain this, Rafael and his brother, and **every PR is reviewed and
merged by one of us**. Nothing lands on `main` automatically, including our own
work. Expect days rather than hours, and nudge us if it goes quiet. That is not
rudeness, it is helpful.

**Some PRs will be declined, and it is worth saying why in advance.** Almost
never because the code is bad. Usually because the feature pulls pqp somewhere
we are deliberately not going, or because it is right but not right now. Both of
those are decisions about the product, not judgements about you or your work.

We would rather say that before you build it than after, which is the entire
reason for the "talk to us first" rule above and for keeping the issue list
public. If you ask and we say no, you lost five minutes. If you build for a
weekend and we say no, we both lost, and that one is on us for not answering
sooner.

So: ask early, ask about anything, and take a slow reply as a slow reply rather
than a hint. If a PR does get declined we will tell you why in plain words, and
it does not mean the next one will be.
